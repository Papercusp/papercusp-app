/**
 * p2p/offer-executor-prod-deps.ts — WI-1937 production implementation of the
 * two REQUIRED-with-no-default `OfferExecutorDeps` ports offer-executor.ts
 * leaves for the caller to inject: `applyCapabilityEnvelope` and
 * `launchSession`.
 *
 * Split out from offer-executor.ts itself (which stays pure/host-agnostic and
 * unit-tests against hand-rolled stubs) so the actual envelope + spawn wiring
 * lives next to what it wires INTO (capability-envelope/policy.ts,
 * fleet/operator-spawn.ts) rather than inside the pure execution engine.
 *
 * D-001 UPDATE (p2p-public-release-remaining-lanes-2026-07-16, owner,
 * 2026-07-17 — supersedes the 2026-07-09 sequencing note this used to carry):
 * the deny-all `ROLE_ENVELOPES['foreign-session']` entry `applyCapabilityEnvelope`
 * below used to verify is RETIRED (capability-envelope/policy.ts HISTORY note).
 * Owner's verbatim call: "we don't want os OR app level containment... We
 * already have a trust layer... That's the only security layer I want to
 * support for v1." So this port is now a NO-OP: the capability-envelope layer
 * no longer participates in gating a foreign-work spawn at all — the trust
 * chain upstream of execution (offer-authorship.ts + resolveForeignWorkAdmission
 * + P-202 allotments + user_trust_list) is the entire v1 security model. The
 * port SHAPE (`Promise<void>`, throw = refuse) is kept byte-identical so
 * offer-executor.ts's call site and every existing test double are unchanged;
 * only this implementation's body changed. Re-arm a real check here only via a
 * fresh, explicitly owner-ratified follow-up.
 */
import { spawnAgentInHarness } from '../fleet/operator-spawn';
import { ephemeralForeignHarnessSlug } from '../harness-registry';
import { buildForeignProcessEnv } from './sandbox/pg-credential-isolation';
import type { ForeignLaunchSpec, OfferExecutorDeps } from './offer-executor';

/**
 * D-001: capability-envelope gating for foreign sessions is retired (see the
 * module doc above) — this always resolves. Kept as a named, awaited step
 * (rather than deleting the port/call site) so offer-executor.ts's pipeline
 * shape — and its "envelope failure parks the row" refusal path — stays
 * exercised and ready if a future owner-ratified policy re-arms a real check.
 */
export async function applyCapabilityEnvelopeForForeignSession(_spec: {
  sessionRole: 'foreign-session';
  offerId: string;
  workspaceId: string;
  fleetSlug: string;
}): Promise<void> {
  // D-001: no-op by design — see module doc comment.
}

/**
 * D-001 `launchSession` — WI-1937 option B (leader steer, msg mre5tvu2
 * 2026-07-09): resolved.
 *
 * `spawnAgentInHarness` (fleet/operator-spawn.ts) — the ONE production spawn
 * chokepoint every other agent in this codebase goes through — resolves its
 * process cwd EXCLUSIVELY via `resolveProject(harnessSlug, workspaceId)`
 * against `harness_shared` project registry rows (`lib/harness-core.ts`).
 * There is NO parameter, extras key, or override path that lets a caller
 * spawn a real agent process cwd'd into an ARBITRARY filesystem path — and a
 * foreign-work clone (`ForeignLaunchSpec.clonePath`, produced by
 * `provisionForeignClone`, foreign-clone.ts) is exactly that: a standalone git
 * clone the offer-executor pipeline creates on the fly.
 *
 * The gap is closed WITHOUT any core-spawn-path change: `provisionForeignClone`
 * now registers an EPHEMERAL `harness_registry` row for the clone the moment
 * it's provisioned (foreign-clone.ts, `registerEphemeralForeignHarness`),
 * deregistered when the session is reaped (revocation-reaper.ts) or caught by
 * the orphan sweep (`sweepOrphanedEphemeralForeignHarnesses`) if that call was
 * missed. So by the time THIS function runs, `resolveProject` already finds
 * the clone under `ephemeralForeignHarnessSlug(spec.offer.offerId)` — this
 * just spawns into that slug like any other harness. Enumeration/listing
 * sites (`projects-lite.ts`, the default-harness inference in
 * `operator-spawn.ts`, `/api/harness/projects`) filter the row out via
 * `isEphemeralForeignProject` so it never leaks into human-facing UI; a
 * slug-scoped lookup — exactly what this does — is unaffected by design.
 *
 * WI-3786 P-105 WIRING (Phase 1 — §3.2 PG credential isolation):
 * `buildForeignProcessEnv` filters out admin-PG-shaped environment variables
 * (DATABASE_URL, PG* keys) so foreign sessions cannot inherit a live connection
 * string via env resolver fallbacks. The filtered vars are passed via extras
 * to ensure the spawned process sees the deny-all env posture.
 */
export async function launchForeignSession(spec: ForeignLaunchSpec): Promise<{ sessionId: string }> {
  const harness = ephemeralForeignHarnessSlug(spec.offer.offerId);
  
  // P-105 §3.2: build PG-filtered environment for the foreign session.
  // This is pure logic — no privilege needed, safe to run on any host.
  const filteredEnv = buildForeignProcessEnv(process.env);
  
  // Convert the filtered environment object to the extras array format (KEY=VALUE strings).
  // Only include variables that are explicitly set (not undefined).
  const pgEnvExtras = Object.entries(filteredEnv)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  
  const res = await spawnAgentInHarness({
    // Descriptive attribution for the observe-only governor receipt (D-011).
    spawnCaller: 'p2p/offer-executor-prod-deps',
    workspaceId: spec.workspace.workspaceId,
    harness,
    role: spec.sessionRole,
    fleet: { slug: spec.workspace.fleetSlug, role: spec.sessionRole },
    turnTrigger: 'p2p-foreign-offer',
    parentRole: 'p2p:offer-executor',
    // P-105: pass the filtered environment + presence label as extras.
    // The filtered env ensures admin-PG keys are stripped from the spawned process.
    extras: [
      `PAPERCUSP_FOREIGN_PRESENCE_LABEL=${spec.presenceLabel}`,
      ...pgEnvExtras,
    ],
  });
  if (!res.ok || !res.spawnId) {
    throw new Error(
      `launchForeignSession: spawnAgentInHarness refused for offer ${spec.offer.offerId} ` +
        `(harness=${harness}): ${res.error ?? 'no spawnId returned'}`,
    );
  }
  return { sessionId: res.spawnId };
}

/** Convenience composer for the ports this module owns. */
export function foreignSessionExecutorDeps(): Pick<OfferExecutorDeps, 'applyCapabilityEnvelope' | 'launchSession'> {
  return {
    applyCapabilityEnvelope: applyCapabilityEnvelopeForForeignSession,
    launchSession: launchForeignSession,
  };
}
