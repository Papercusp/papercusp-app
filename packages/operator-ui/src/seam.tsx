/**
 * The host seam for @papercusp/operator-ui.
 *
 * These components were written INSIDE the operator SPA and reached for three
 * things that belong to the app, not to the panel: a router `Link`, a `toast`
 * surface, and same-origin `/api/...` reachability. The cloud portal is a
 * Next app on a different origin with a different router and no sonner, so
 * those three are the entire reason the panel could not simply be imported.
 *
 * They are injected here instead of imported, so the component keeps ONE
 * implementation and each host supplies its own three answers:
 *
 *   operator-vite → TanStack `Link`, sonner `toast`, identity `apiFetch`
 *   portal        → an <a> into the operator origin, the portal's toast,
 *                   an `apiFetch` that routes through the portal's proxy
 *
 * WHY DEFAULTS EXIST AND WHAT THEY COST: an unconfigured host still renders a
 * working panel (plain <a>, console-logged toasts, same-origin fetch) rather
 * than crashing on a null. That is deliberate — a missing configure() call
 * should degrade one affordance, not blank the pane — but it does mean a host
 * that forgets to configure gets silent console toasts instead of an error.
 * `operatorUiConfigured()` exists so a host can assert it wired the seam.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { pinModuleState } from '@papercusp/module-singleton';

/** Props every host's link component must accept — the subset the panels use. */
export interface OperatorUiLinkProps {
  /** An operator-app-relative route, e.g. `/settings/deploy-accounts`. */
  to: string;
  className?: string;
  children?: ReactNode;
}

/** The toast surface the panels call. Only these two levels are used. */
export interface OperatorUiToast {
  success(message: string): void;
  error(message: string): void;
}

export interface OperatorUiSeam {
  Link: ComponentType<OperatorUiLinkProps>;
  toast: OperatorUiToast;
  /**
   * Fetch an OPERATOR API path (always written operator-relative, e.g.
   * `/api/admin/deploy-accounts/session-override`). A host that is not the
   * operator rewrites it onto its own proxy.
   */
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
}

function DefaultLink({ to, className, children }: OperatorUiLinkProps) {
  // A plain anchor, not a no-op: an unconfigured host should still be able to
  // follow the link if its routes happen to line up.
  return <a href={to} className={className}>{children}</a>;
}

const DEFAULT_SEAM: OperatorUiSeam = {
  Link: DefaultLink,
  toast: {
    success: (m) => console.info('[operator-ui]', m),
    error: (m) => console.error('[operator-ui]', m),
  },
  apiFetch: (path, init) => fetch(path, init),
};

/**
 * Pinned to globalThis rather than held in a module-scoped `let`.
 *
 * This package is reached by three different loaders (Vite in operator-vite,
 * webpack in the portal, vitest in tests) and, in the portal, through a `file:`
 * symlink into another checkout. Any of those can produce a SECOND module
 * record, and with a plain module-scoped variable the host's configure() would
 * write to one record while the components read the other — the panel would
 * silently fall back to defaults with nothing in any log to say why. See the
 * repo's shared-lib singleton rule.
 */
const state = pinModuleState('@papercusp/operator-ui.seam', () => ({
  seam: DEFAULT_SEAM,
  configured: false,
}));

/**
 * Install the host's implementations. Call once, at app boot, BEFORE any panel
 * renders. Partial: pass only what differs from the defaults.
 */
export function configureOperatorUi(seam: Partial<OperatorUiSeam>): void {
  state.seam = { ...state.seam, ...seam };
  state.configured = true;
}

/** Whether a host has called configureOperatorUi — for a boot-time assertion. */
export function operatorUiConfigured(): boolean {
  return state.configured;
}

/** The live seam. Read at call time, never destructured at module scope. */
export function operatorUi(): OperatorUiSeam {
  return state.seam;
}

/**
 * Which machine the workspace's files live on — the one host answer that is
 * per-SESSION rather than per-boot, so it is a React context and not a
 * configure() field: the portal only learns it after its session check.
 *
 * Panels that ask for a filesystem path ("New local directory", "Existing
 * local repo") mean "on the machine running the operator". On the desktop
 * that is the user's own computer; for a signed-in portal user it is their
 * cloud workspace machine, where "local" names the wrong machine
 * (WI-10003268).
 *
 * The context OBJECT is pinned for the same reason the seam is: a second
 * module record would hand the provider and the reader two different
 * contexts, and the reader would silently see the default.
 */
export type OperatorWorkspaceLocation = 'local' | 'cloud';

const locationState = pinModuleState('@papercusp/operator-ui.workspace-location', () => ({
  context: createContext<OperatorWorkspaceLocation>('local'),
}));

export function OperatorWorkspaceLocationProvider({
  location,
  children,
}: {
  location: OperatorWorkspaceLocation;
  children?: ReactNode;
}) {
  const { Provider } = locationState.context;
  return <Provider value={location}>{children}</Provider>;
}

/** `'local'` unless a host provided otherwise — the desktop's own answer. */
export function useOperatorWorkspaceLocation(): OperatorWorkspaceLocation {
  return useContext(locationState.context);
}
