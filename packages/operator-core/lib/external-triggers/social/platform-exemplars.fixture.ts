/**
 * Registry exemplars for tests, DERIVED rather than hardcoded — P-022.
 *
 * WHY THIS EXISTS. Several suites need "a platform that is not verified" or "a
 * platform that declares no egress hosts" to prove a refusal path. Naming one
 * makes the test read well and rot silently: the moment that platform gets
 * verified — which is the whole point of this plan — the test fails for a
 * reason that has nothing to do with what it is testing.
 *
 * That is not hypothetical. The same "unverified platform" exemplar has now
 * moved THREE times: bluesky to linkedin (P-021), linkedin to tiktok (P-021),
 * and tiktok to whatever remains (P-022) — each time as collateral damage from
 * a successful verification, and each time leaving behind a comment explaining
 * why it moved. The tests were never wrong; they were pinned to an INSTANCE of
 * a property instead of the property.
 *
 * So these helpers ask the registry. A suite that says "pick the unverified
 * one" keeps testing the refusal for as long as a refusable row exists, and
 * says so LOUDLY when none does — which is a real event worth failing on, not
 * something to skip past. An empty registry match means the refusal branch has
 * become unreachable from real data and belongs on a synthetic row instead
 * (the pattern socialWriteRefusal already documents for `write-unverified`).
 */
import {
  isSocialPlatformVerified,
  listSocialPlatforms,
  type SocialPlatformId,
  type SocialPlatformRow,
} from './platform-registry';

function pick(predicate: (row: SocialPlatformRow) => boolean, what: string): SocialPlatformId {
  const match = listSocialPlatforms().find(predicate);
  if (!match) {
    throw new Error(
      `platform-exemplars: no registry row is ${what}. This is a REAL finding, not a broken ` +
        `fixture: the branch under test is no longer reachable from live data, so it needs a ` +
        `synthetic row rather than a registry lookup. Do not delete the assertion.`,
    );
  }
  return match.id;
}

/**
 * A platform whose row has never been verified, so every gate must refuse it.
 *
 * Stable in practice because x-twitter is parked indefinitely on an owner cost
 * decision (D-002), but derived anyway so that fact is not load-bearing.
 */
export function anUnverifiedPlatformId(): SocialPlatformId {
  return pick((row) => !isSocialPlatformVerified(row), 'unverified');
}

/**
 * A platform that declares NO API hosts under a `fixed` host policy — the
 * egress deny case, which is a different property from being unverified even
 * though the same rows happen to satisfy both today.
 */
export function aNoEgressHostPlatformId(): SocialPlatformId {
  return pick(
    (row) => row.egress.hostPolicy === 'fixed' && row.egress.apiHosts.length === 0,
    'declaring zero API hosts under a fixed host policy',
  );
}
