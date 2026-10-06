/**
 * WI-10005919 — one read of the mem0-federation-egress flag, with an explicit
 * verdict on whether the value is AUTHORITATIVE.
 *
 * The merge loop snapshots this flag once per pass, and the snapshot decides the
 * apply binding plus whether memory ops apply at all. The old read collapsed
 * every failure into `false`: `getFlag` serves the compiled default (OFF for this
 * owner-authority flag) when the override store is unreachable or slow and no map
 * is cached, and the boot-local wrapper turned a throw into `false` as well. A
 * degraded read was therefore indistinguishable from the owner turning the flag
 * OFF, and nothing logged it.
 *
 * `degraded` is null for an authoritative read and a short reason otherwise; the
 * caller decides what to fall back to (boot.ts holds the last authoritative value).
 */
import { getFlagAttestation, type FlagAttestation } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

export interface MemoryFederationFlagRead {
  value: boolean;
  /** null = authoritative; otherwise why the value cannot be trusted. */
  degraded: string | null;
  elapsedMs: number;
}

/**
 * Whether a resolved attestation reflects the owner's setting. Only `store-error`
 * is degraded: the override store failed AND no map for this scope was cached, so
 * the value fell through to PostHog or the compiled default. A stale-cache fallback
 * still serves the last good map, and env/test/platform overrides never read the
 * store; an unconfigured store is a deployment state, not a transient failure.
 */
export function memoryFederationFlagReadDegradation(
  attestation: Pick<FlagAttestation, 'source' | 'overrideRead'>,
): string | null {
  if (attestation.overrideRead.kind !== 'store-error') return null;
  // WI-10006242: quote the load error. It is the only thing that tells a store that
  // timed out from one that refused, and under the unit-layer no-real-PG rail it is the
  // rail's own text, which the shared test console filter already recognises.
  return (
    `override store unreadable with no cached map (value came from ${attestation.source}; ` +
    `load error: ${attestation.overrideRead.loadError ?? 'not reported'})`
  );
}

/**
 * The console line boot.ts emits for a degraded read. Kept here, beside the read, so
 * the unit-rail guard test asserts on the exact text production writes.
 */
export function formatMemoryFederationDegradedWarn(input: {
  workspaceId: string;
  harnessSlug: string;
  when: 'boot' | 'pass';
  read: Pick<MemoryFederationFlagRead, 'degraded' | 'elapsedMs'>;
  degradedReadsThisBoot: number;
  outcome: string;
}): string {
  return (
    `[read-merge] [${input.workspaceId}/${input.harnessSlug}] WI-10005919: mem0-federation flag ` +
    `${input.when} read degraded (${input.read.degraded}, ${input.read.elapsedMs}ms; degraded reads this boot: ` +
    `${input.degradedReadsThisBoot}) — ${input.outcome}`
  );
}

export async function readMemoryFederationFlagOnce(
  injected?: () => Promise<boolean>,
  now: () => number = Date.now,
): Promise<MemoryFederationFlagRead> {
  const startedAt = now();
  try {
    if (injected) {
      return { value: (await injected()) === true, degraded: null, elapsedMs: now() - startedAt };
    }
    const attestation = await getFlagAttestation(FLAGS.MEM0_FEDERATION_EGRESS, 'system');
    return {
      value: attestation.resolvedValue === true,
      degraded: memoryFederationFlagReadDegradation(attestation),
      elapsedMs: now() - startedAt,
    };
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { value: false, degraded: `flag read threw (${detail})`, elapsedMs: now() - startedAt };
  }
}
