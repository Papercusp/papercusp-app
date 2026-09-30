/**
 * beacon-consent — the owner's per-Hive consent to PUBLISH a live status beacon
 * onto the directory gossip topic (hive-network-surface-2026-06-11 P-005, brief
 * B-07; contract C-2).
 *
 * Publishing a hive's activity summary onto the public directory is an
 * outward-facing privacy act, so consent is owner-gated and DEFAULT-OFF (D-002):
 * the absence of the setting is OFF, and only an explicit owner opt-in flips it
 * on. The consent question is asked at the natural moment — inside the
 * hive-publish flow (the creation form / the header-strip flip), not only a
 * buried settings toggle (D-002 amendment) — and routed through this accessor.
 *
 * Stored as a single `hive_settings` value keyed by the Hive's home slug, so it
 * federates to ALL of this Hive's Swarms over the Hive peer-log (every Swarm
 * reads the same consent before publishing). The accessor is the seam B-06's
 * beacon publisher consumes — `getBeaconPublishConsent` is the gate it checks
 * before piggybacking a beacon on the directory re-announce; this module owns
 * the consent KEY, B-06 owns the beacon PAYLOAD schema (C-2).
 *
 * Mirrors `cross-hive-grants.ts` (the sibling hive_settings-backed owner policy).
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from './hive-settings-store';

/** The single hive_settings key under which the beacon publish consent lives (C-2). */
export const BEACON_PUBLISH_CONSENT_KEY = 'beacon-publish-consent';

/**
 * Read this Hive's beacon-publish consent. Absent (or any non-`true` value) = OFF
 * per C-2 — the default-deny posture is structural, so a missing row, a legacy
 * junk value, or an explicit `false` all read as "do not publish".
 */
export async function getBeaconPublishConsent(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const rec = await getHiveSetting(workspaceId, potHomeSlug, BEACON_PUBLISH_CONSENT_KEY, sql);
  return rec?.value === true;
}

/**
 * Set (upsert) this Hive's beacon-publish consent. The value federates over the
 * Hive's peer-log via the capture trigger, so every Swarm of the Hive enforces
 * the same consent. Coerced to a strict boolean — the stored shape is exactly
 * `true` | `false` so the `=== true` read above is unambiguous.
 */
export async function setBeaconPublishConsent(
  workspaceId: string,
  potHomeSlug: string,
  consent: boolean,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting(
    { workspaceId, potHomeSlug, settingKey: BEACON_PUBLISH_CONSENT_KEY, value: consent === true },
    sql,
  );
}
