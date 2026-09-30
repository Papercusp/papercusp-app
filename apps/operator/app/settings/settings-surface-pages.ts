/**
 * The Settings sub-pages as a ROUTE-FREE table, keyed by the sub-path under
 * `/settings` (portal-parity D-009 / P-005, WI-2143414).
 *
 * WHY THIS EXISTS. The operator reaches its settings sub-pages through a
 * router: `apps/operator-vite/src/routes/settings/**` mounts each `page.tsx`
 * under the shared `SettingsLayout`. A host that mounts the operator's
 * components WITHOUT that router (the web portal, which renders operator
 * surfaces natively through `@papercusp/operator-ui/surfaces`) has no route
 * table to hand the layout its child. This is that table — the same page
 * modules the routes render, lazily so a host pays only for the page it shows.
 *
 * ⚠ HAND-MAINTAINED, so it can drift from the route set — the classic second
 * copy of a truth the filesystem owns. `settings-surface-pages.test.ts` pins it:
 * the test derives the sub-path set from `routes/settings/**` and from the
 * `settings/**​/page.tsx` files and fails when either disagrees with the keys
 * here. Add a settings page → add a row here, or that test names it.
 *
 * No React component lives in this module on purpose: the pin test imports it
 * under node, and `lazy()` defers every `import()` until first render, so the
 * table stays inert (no operator module graph, no jsdom) until a host mounts it.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type SettingsPage = LazyExoticComponent<ComponentType<Record<string, never>>>;

/** The sub-path a bare `/settings` resolves to — the first page of the first nav group. */
export const DEFAULT_SETTINGS_SUBPATH = 'profile';

export const SETTINGS_SURFACE_PAGES = {
  agent: lazy(() => import('./agent/page')),
  'api-keys': lazy(() => import('./api-keys/page')),
  autonomy: lazy(() => import('./autonomy/page')),
  backups: lazy(() => import('./backups/page')),
  'deploy-accounts': lazy(() => import('./deploy-accounts/page')),
  'expert-routing': lazy(() => import('./expert-routing/page')),
  identities: lazy(() => import('./identities/page')),
  mobile: lazy(() => import('./mobile/page')),
  omp: lazy(() => import('./omp/page')),
  operator: lazy(() => import('./operator/page')),
  p2p: lazy(() => import('./p2p/page')),
  personalization: lazy(() => import('./personalization/page')),
  'personal-vault': lazy(() => import('./personal-vault/page')),
  'plugin-runtime': lazy(() => import('./plugin-runtime/page')),
  plugins: lazy(() => import('./plugins/page')),
  'plugins/tools': lazy(() => import('./plugins/tools/page')),
  'pot-customization': lazy(() => import('./pot-customization/page')),
  profile: lazy(() => import('./profile/page')),
  'prompt-studio': lazy(() => import('./prompt-studio/page')),
  // The one sub-page with no `page.tsx`: its route mounts the client
  // component directly, behind `requireFlag(FLAGS.CLOUDFLARE_PUBLISH)`. The
  // surface applies the same gate through the layout's own route→flag map.
  publishing: lazy(() => import('./publishing/PublishingClient')),
  'setup-wizard': lazy(() => import('./setup-wizard/page')),
  shortcuts: lazy(() => import('./shortcuts/page')),
  storage: lazy(() => import('./storage/page')),
  trust: lazy(() => import('./trust/page')),
  user: lazy(() => import('./user/page')),
  'user/memory': lazy(() => import('./user/memory/page')),
  'user/search': lazy(() => import('./user/search/page')),
  voice: lazy(() => import('./voice/page')),
} satisfies Record<string, SettingsPage>;

export type SettingsSubPath = keyof typeof SETTINGS_SURFACE_PAGES;

export function isSettingsSubPath(sub: string): sub is SettingsSubPath {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SURFACE_PAGES, sub);
}

/**
 * The sub-page a settings pathname selects: `/settings` → the default,
 * `/settings/<sub>[/]` → `<sub>` when a page exists for it, else `null` (an
 * operator route this table does not mount — the caller decides what to show).
 */
export function settingsSubPathFor(pathname: string): SettingsSubPath | null {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '/settings' || trimmed === '') return DEFAULT_SETTINGS_SUBPATH;
  if (!trimmed.startsWith('/settings/')) return null;
  const sub = trimmed.slice('/settings/'.length);
  return isSettingsSubPath(sub) ? sub : null;
}
