/**
 * @papercusp/operator-ui — operator panels, mountable outside the operator.
 *
 * WHY THIS PACKAGE EXISTS (WI-2143109): the cloud portal used to render these
 * surfaces in iframes pointed at the operator origin. An iframe is not a
 * component — it cannot share the page's layout, theme, focus or router, and
 * the framed routes were not even present in the deployed operator build, so
 * several docks were rendering the operator's own 404 page inside a box.
 *
 * The fix is not to reimplement the panels in the portal (two copies that drift
 * are worse than an iframe). It is to MOVE each panel here verbatim, isolate
 * the three things that were genuinely app-specific behind `configureOperatorUi`,
 * and let both apps import the same component.
 *
 * A host does three things, once, at boot:
 *   1. configureOperatorUi({ Link, toast, apiFetch })
 *   2. inject the panel's CSS string (each panel exports its own)
 *   3. render the panel inside a `SyncProvider` bound to a reachable sync endpoint
 */
export {
  configureOperatorUi,
  operatorUi,
  operatorUiConfigured,
  OperatorWorkspaceLocationProvider,
  useOperatorWorkspaceLocation,
  type OperatorUiSeam,
  type OperatorUiLinkProps,
  type OperatorUiToast,
  type OperatorWorkspaceLocation,
} from './seam';

// The one Papercup chat (papercup-chat-one-component-one-contract-2026-09-06,
// D-003) — also reachable as the `./papercup-chat` subpath.
export * from './papercup-chat';

export { default as AccountsTab } from './accounts/AccountsTab';
export { useAccountOverride, type AccountOverride } from './accounts/use-account-override';
export { ACCOUNTS_TAB_CSS, ACCOUNTS_TAB_BASE_CSS } from './accounts/accounts-tab.styles';
