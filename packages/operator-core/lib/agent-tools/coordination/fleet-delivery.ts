/**
 * fleet-delivery.ts — the per-member delivery OVERRIDE for a named fleet
 * (fleet-broadcast-audience-history-integration-2026-06-30 P-009 →
 *  fleet-delivery-override-mute-digest-2026-06-30 D-001).
 *
 * Fleet membership is DERIVED (coord_presence.fleet_slug) — there is no positive
 * "subscribe to a fleet". This override is the OPTIONAL "+ override" half: a member
 * who finds a fleet's broadcasts noisy can downgrade their OWN live delivery without
 * leaving the fleet. It is modeled on the existing subscription substrate as a row
 * in coord_entity_subscriptions with target_kind='fleet', target_ref=<fleet slug>,
 * delivery_mode ∈ {digest, muted} (D-001 — no new table, no exclusion list):
 *
 *   (no row)  → 'full'   the derived default — full live delivery, zero bookkeeping
 *   'digest'  → coalesced delivery via the fanout digest path
 *   'muted'   → NO live delivery; the audience-history is untouched (still pullable
 *               via coord:catch-up), so a muted member catches up on demand
 *
 * Read at @fleet: expansion (exclude/route members) and written by the toggle tool.
 */
import { getCoordSubscriptionStore } from './subscription-store';
import type { DeliveryMode } from '@papercusp/coordination/capabilities';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { fleetSlugFromName } from '../../agent-fleets-store';
import { deliverInject, type InjectSink } from './fanout-delivery';

/** The subscription target_kind that carries a fleet delivery override. */
export const FLEET_DELIVERY_KIND = 'fleet' as const;

/**
 * Every member's delivery override for `fleetSlug` → Map<ownerId, mode>. A member
 * ABSENT from the map has no override = the derived default ('full'). Reuses the
 * subscription store's hot-path target read, so this is one query for the whole
 * fleet (what the @fleet: expansion needs to filter/route N members at once).
 */
export async function getFleetDeliveryOverrides(fleetSlug: string): Promise<Map<string, DeliveryMode>> {
  const out = new Map<string, DeliveryMode>();
  const slug = fleetSlug.trim();
  if (!slug) return out;
  const rows = await getCoordSubscriptionStore().listTargetSubscribers(FLEET_DELIVERY_KIND, slug);
  for (const r of rows) out.set(r.subscriber_id, r.delivery_mode);
  return out;
}

/** One member's delivery for `fleetSlug` ('full' when no override row). */
export async function getFleetDelivery(memberOwnerId: string, fleetSlug: string): Promise<DeliveryMode> {
  return (await getFleetDeliveryOverrides(fleetSlug)).get(memberOwnerId) ?? 'full';
}

/**
 * Set a member's delivery for `fleetSlug`. 'full' CLEARS the override (back to the
 * derived default); 'digest'/'muted' write/update the downgrade row. ('mention' is
 * accepted by the type but isn't a meaningful fleet-broadcast mode — callers should
 * pass full|digest|muted.)
 */
export async function setFleetDelivery(
  memberOwnerId: string,
  fleetSlug: string,
  mode: DeliveryMode,
): Promise<void> {
  const slug = fleetSlug.trim();
  const store = getCoordSubscriptionStore();
  if (mode === 'full') {
    await store.unsubscribe(memberOwnerId, FLEET_DELIVERY_KIND, slug);
    return;
  }
  await store.subscribe({
    subscriber_id: memberOwnerId,
    target_kind: FLEET_DELIVERY_KIND,
    target_ref: slug,
    delivery_mode: mode,
    created_ts: new Date().toISOString(),
  });
}

/** Extract the canonical fleet slugs from a `to[]` — the `@fleet:<name>` entries
 *  (NOT `@fleet-leader:`, which targets one owner, not the digest cohort). */
function fleetSlugsInTo(to: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of to) {
    if (t.startsWith('@fleet:')) {
      const body = t.slice('@fleet:'.length).trim();
      if (body) out.add(fleetSlugFromName(body));
    }
  }
  return [...out];
}

/**
 * Deliver the DIGEST sidecar for an `@fleet:` broadcast. The live `to` already
 * excludes digest members (listFleetMembers drops them), so they'd otherwise get
 * nothing; here each digest member gets a terse `digest:true` notify (the inbox hook
 * coalesces it — fanout-delivery: "digest changes RENDERING, not delivery"). Skips
 * any member already in `finalTo` (e.g. also addressed directly — a direct address
 * wins, no double-send). Best-effort + side-effect-only; returns the count delivered.
 * Called once per send from sendMessage, guarded on an `@fleet:` selector being present.
 */
export async function deliverFleetDigests(
  originalTo: readonly string[],
  env: CoordEnvelope,
  finalTo: readonly string[],
  deps: {
    getOverrides?: (fleetSlug: string) => Promise<Map<string, DeliveryMode>>;
    sink?: InjectSink;
  } = {},
): Promise<number> {
  const getOverrides = deps.getOverrides ?? getFleetDeliveryOverrides;
  const slugs = fleetSlugsInTo(originalTo);
  if (slugs.length === 0) return 0;
  const already = new Set(finalTo);
  let n = 0;
  for (const slug of slugs) {
    const overrides = await getOverrides(slug);
    for (const [memberId, mode] of overrides) {
      if (mode !== 'digest' || already.has(memberId)) continue;
      const delivered = await deliverInject(
        { subscriber_id: memberId, delivery_mode: 'digest', via: `fleet:${slug}` },
        {
          from: env.from,
          subject: `fleet:${slug}`,
          summary: env.summary ?? `(fleet ${slug} broadcast)`,
          notify_kind: 'fleet_broadcast',
          ...(env.body != null ? { body: env.body } : {}),
          extra: {
            ...(Array.isArray(env.audience) ? { audience: env.audience } : {}),
            ...(env.plan_slug != null ? { plan_slug: env.plan_slug } : {}),
          },
        },
        deps.sink,
      );
      if (delivered) n += 1;
    }
  }
  return n;
}
