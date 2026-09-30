/**
 * Operator host-adapter for `@papercusp/deployment-driver`.
 *
 * `cloud-deployment-layer-2026-06-06` P-009. Registers the cloud backends via the
 * package's `configureDeployment()` host seam (`LocalDriver` is the built-in
 * default, always present). Imported for its side-effect by the deployment-
 * resolution sites — the harness:create boundary (`./config-schema`) and the
 * orchestrator placement gate (`dbos/orchestrator-loop`) — so a `{target:'latitude'}`
 * config resolves to the real driver no matter which module loads first.
 *
 * `configureDeployment` only mutates a process-global registry, so repeated
 * imports (ESM evaluates this module once) are a no-op.
 */
import { configureDeployment } from '@papercusp/deployment-driver';
import { makeLatitudeDriver } from './latitude/latitude-driver';
import { makeHetznerDriver } from './hetzner/hetzner-driver';
import { makeGcpDriver } from './gcp/gcp-driver';
import { loggingHeadlessPeerAdmission, makeHeadlessJoinHook } from './headless-peer';

/**
 * The owner-vouched headless-peer admission (P-015). Default is the logging
 * adapter until the substrate adapter is wired; deploy teardown revokes through
 * this same instance, so admit + revoke stay symmetric.
 */
export const headlessAdmission = loggingHeadlessPeerAdmission((lvl, m) => console.log(`[${lvl}] ${m}`));

/** Drivers admit an auto-provisioned frame as a headless peer on join (P-015). */
const onJoin = makeHeadlessJoinHook(headlessAdmission);

configureDeployment({
  drivers: [makeLatitudeDriver({ onJoin }), makeHetznerDriver({ onJoin }), makeGcpDriver({ onJoin })],
});
