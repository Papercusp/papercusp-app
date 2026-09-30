/**
 * The left sidebar's Accounts tab — now a re-export, not an implementation.
 *
 * The panel itself MOVED to @papercusp/operator-ui (WI-2143109) so the cloud
 * portal can mount the identical component instead of rendering this app in an
 * iframe. Nothing about it changed in the move: the operator installs its own
 * router `Link`, sonner `toast` and same-origin `apiFetch` through
 * `configureOperatorUi` in routes/__root.tsx, which is the only difference
 * between the two hosts.
 *
 * This file stays because `LeftSidebar.tsx` lazy-imports it by path and its
 * test suite renders it by path — a lazy chunk boundary is a deliberate part of
 * this rail's boot cost, and re-pointing those at the package would collapse it
 * into the main bundle for no gain.
 */
export { AccountsTab as default } from '@papercusp/operator-ui';
