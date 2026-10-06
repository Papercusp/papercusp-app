/**
 * Arm the two remote-access reconcilers for one operator process: the own-tunnel listener and
 * connector (external-app-access P-009) and the opt-in Papercusp relay connector (P-008, D-031).
 *
 * hono-host boots one of three process shapes and must arm the right set in each:
 *  - `single-process`: a host serving HTTP with no forked workers (one HTTP worker, so the
 *    cluster handle's role is `primary`). The desktop app's operator runs this way. It is the
 *    host singleton, so it owns both connectors.
 *  - `cluster-primary`: the forked cluster's primary. It serves no HTTP but is the host
 *    singleton, so it owns both connectors.
 *  - `cluster-worker`: a forked request worker. It opens its own own-tunnel listener but never
 *    dials the relay, because only the host singleton may hold the relay connector.
 *
 * WI-10004423: hono-host used to arm the relay reconciler only on the cluster-primary path, so a
 * single-process host (every desktop install) polled the portal once when Connect was pressed
 * and never again, and an approved link never finished. Both boot paths now call this one
 * function, so the two reconcilers cannot be armed on different paths again.
 *
 * Both starters are idempotent per process, never throw, and converge on a later tick when the
 * first pass runs before boot migrations have applied.
 */
import { startOwnTunnelReconciler } from '../own-tunnel/service';
import { startPortalRelayReconciler } from './relay-opt-in';

export type RemoteAccessProcessRole = 'single-process' | 'cluster-primary' | 'cluster-worker';

export type RemoteAccessReconciler = 'own-tunnel' | 'portal-relay';

/** Which reconcilers a process of this role arms. Pure, so the boot decision is testable. */
export function remoteAccessReconcilersFor(role: RemoteAccessProcessRole): RemoteAccessReconciler[] {
  return role === 'cluster-worker' ? ['own-tunnel'] : ['own-tunnel', 'portal-relay'];
}

/**
 * The role of a process that serves HTTP, from its cluster handle. A `primary` handle here means
 * one HTTP worker, so the primary serves HTTP itself: a single-process host. Only a forked
 * request worker reports `worker`.
 */
export function httpServingProcessRole(
  clusterHandle: { readonly role: 'primary' | 'worker' } | null | undefined,
): RemoteAccessProcessRole {
  return clusterHandle?.role === 'worker' ? 'cluster-worker' : 'single-process';
}

export interface RemoteAccessReconcilerStarters {
  readonly 'own-tunnel': () => void;
  readonly 'portal-relay': () => void;
}

const DEFAULT_STARTERS: RemoteAccessReconcilerStarters = {
  'own-tunnel': () => startOwnTunnelReconciler(),
  'portal-relay': () => startPortalRelayReconciler(),
};

/** Arm this process's remote-access reconcilers. Returns the ones it armed. */
export function startRemoteAccessReconcilers(
  role: RemoteAccessProcessRole,
  starters: RemoteAccessReconcilerStarters = DEFAULT_STARTERS,
): RemoteAccessReconciler[] {
  const armed = remoteAccessReconcilersFor(role);
  for (const name of armed) starters[name]();
  return armed;
}
