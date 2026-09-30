/**
 * Papercusp binding for @papercusp/resource-profile — inject the two domain
 * signals the generic lib can't sniff, then expose the memoized profile.
 *
 * The generic lib derives every scale cap from raw host signals (cgroup-aware
 * cores + RAM) plus two bits only THIS app knows:
 *
 *  - `embeddedPg`  — does an embedded Postgres share this box? Read from
 *    embedded-pg-discovery: any source OTHER than the native-fallback means the
 *    operator is wired to an embedded/desktop PG that competes for the same
 *    cores/RAM (so the per-core agent budget halves). The native-:5432 fallback
 *    is the dev box / a dedicated DB → not embedded.
 *  - `hostRole`    — does this process run the background machinery (DBOS queues,
 *    drains) or only serve requests? Derived from background-workers.ts: a
 *    utility host (PAPERCUSP_UTILITY_HOST) → 'utility'; a host with background
 *    workers off (the :3170 request-only staging operator) → 'request-only';
 *    otherwise 'full'.
 *
 * Configuration is idempotent and must precede the first profile read; this
 * module configures lazily on first access so any import order is safe.
 *
 * P0 of operator-scalability-event-loop-2026-06-16: the ONE place the host is
 * read; consumers (rate-limit-config seed, future DBOS/pool sizing) read derived
 * caps from here instead of hardcoding for one machine.
 */
import {
  configureResourceProfile,
  detectPowerSource,
  getResourceProfile as getGenericResourceProfile,
  type HostRole,
  type PowerSource,
  type ResourceProfile,
} from '@papercusp/resource-profile';
import { getHarnessAdminUrlWithSource } from './embedded-pg-discovery';
import { backgroundWorkersEnabled, utilityHostEnabled } from './background-workers';

/** An embedded/desktop PG shares the box iff the admin URL was resolved from the
 *  DISCOVERY FILE (~/.papercusp/embedded-pg.json, written by the desktop's Tauri
 *  main when its embedded PG comes up) — the only source that actually means
 *  "an embedded Postgres shares this box's cores/RAM."
 *
 *  EI-2403: this used to be `source !== 'native-fallback'`, which ALSO counted the
 *  `'env'` source (an explicitly-set HARNESS_ADMIN_DATABASE_URL / DATABASE_URL /
 *  PAPERCUSP_PG_URL) as embedded. But a dedicated native-PG server (the dev box,
 *  any production server) sets DATABASE_URL explicitly too — that is NOT an
 *  embedded PG competing for the box's cores/RAM, it's a normal dedicated
 *  connection string. Verified live on the 128-core dev box: the old check
 *  misclassified it embeddedPg=true (and, downstream, backgroundInProcess=true)
 *  while pg-autotune (a SEPARATE, correctly-scoped classifier) tuned shared_buffers
 *  at the dedicated 0.25 ratio — the two disagreed on the exact same box.
 *
 *  Exported (not module-private) so it is directly unit-testable against a
 *  mocked `getHarnessAdminUrlWithSource` without fighting `getResourceProfile`'s
 *  own one-shot memoization — see resource-profile.test.ts. */
export function detectEmbeddedPg(): boolean {
  return getHarnessAdminUrlWithSource().source === 'discovery-file';
}

/** Map the background-workers gates onto the generic HostRole. */
function detectHostRole(env: NodeJS.ProcessEnv = process.env): HostRole {
  if (utilityHostEnabled(env)) return 'utility';
  return backgroundWorkersEnabled(env) ? 'full' : 'request-only';
}

let configured = false;
let detectedOnBattery = false;

/**
 * P5-3: prime the power signal BEFORE the first {@link getResourceProfile}. Power
 * detection is async I/O so it can't ride the lazy-sync config path; call this
 * once early at boot (awaited) and the derived profile reflects battery state
 * (quieter caps + a wider background-tick cadence). Best-effort: a host we can't
 * read resolves 'unknown' ⇒ full power. If the profile was ALREADY read before
 * this runs (a race), the caps are memoized as AC and this is a no-op — so the
 * worst case is "never wrongly throttled", and a server is never throttled at all.
 */
export async function primePowerSource(): Promise<PowerSource> {
  const source = await detectPowerSource();
  detectedOnBattery = source === 'battery';
  return source;
}

/** The memoized Papercusp resource profile. Configures the injected signals on
 *  first access (idempotent), then delegates to the generic memoized singleton. */
export function getResourceProfile(): ResourceProfile {
  if (!configured) {
    configured = true;
    configureResourceProfile({
      embeddedPg: detectEmbeddedPg(),
      hostRole: detectHostRole(),
      onBattery: detectedOnBattery,
    });
  }
  return getGenericResourceProfile();
}

/**
 * Pool size for a SHARED single-purpose utility pool (dock-layouts, llm-testing
 * storage/telemetry, operator-continue-chains, the admin llm-tests routes) — a
 * small fixed pool scaled DOWN on an embedded/desktop PG that shares the box, so a
 * laptop's embedded Postgres isn't oversubscribed (app-wide-load-traps § E, F-E4).
 * A native/dedicated PG keeps 4; an embedded one drops to 2. This is NOT the big
 * org request pool (that is `pgPoolMax`), and NOT for `max:1` LISTEN connections
 * (those stay pinned direct).
 */
export function sharedUtilityPoolMax(): number {
  return getResourceProfile().signals.embeddedPg ? 2 : 4;
}

export type { ResourceProfile, HostClass, HostRole, PowerSource } from '@papercusp/resource-profile';
