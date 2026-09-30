'use client';

/**
 * The operator's Settings as ONE mountable component: `SettingsLayout` around
 * the sub-page the current pathname selects (portal-parity D-009 / P-005,
 * WI-2143414).
 *
 * In the operator this composition is the router's job (`routes/settings.tsx`
 * renders `<SettingsLayout><Outlet/></SettingsLayout>` and each
 * `routes/settings/<sub>.tsx` supplies the outlet). A host without that router
 * — the web portal, mounting operator surfaces natively — gets the same tree
 * from this component: the layout reads `usePathname()` exactly as it does in
 * the operator, and the host's router-compat shim supplies a virtual
 * `/settings/<sub>` pathname (and maps the layout's `RouteLink`s /
 * `router.push` back), so the nav, the highlight and the page all agree.
 */
import { Suspense, type ReactNode } from 'react';
import type { FlagKey } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { usePathname } from '@/lib/router-compat/navigation';
import SettingsLayout, { SETTINGS_PATH_FLAGS } from './layout';
import { SETTINGS_SURFACE_PAGES, settingsSubPathFor } from './settings-surface-pages';

/**
 * The same gate the operator-vite route applies in `beforeLoad`
 * (`requireFlag`): a flagged page renders only while its flag is on. Its own
 * component so the hook call is unconditional whether or not a path is gated.
 */
function FlagGatedPage({ flag, children }: { flag: FlagKey; children: ReactNode }) {
  const enabled = useFlag(flag);
  if (enabled) return <>{children}</>;
  return (
    <p role="status" style={{ color: 'var(--fg-mute)' }}>
      This settings page is behind the <code>{flag}</code> flag, which is off.
    </p>
  );
}

export default function SettingsSurface() {
  const pathname = usePathname();
  const sub = settingsSubPathFor(pathname);
  const Page = sub ? SETTINGS_SURFACE_PAGES[sub] : null;
  const gate = sub ? SETTINGS_PATH_FLAGS[`/settings/${sub}`] : undefined;
  const page = Page ? (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  ) : null;
  return (
    <SettingsLayout>
      {page ? (
        gate ? <FlagGatedPage flag={gate}>{page}</FlagGatedPage> : page
      ) : (
        // An operator settings route this table does not mount. The layout
        // (and its nav) still renders, so the reader is one click from a page
        // that does — this only replaces the outlet, never the chrome.
        <p role="status" style={{ color: 'var(--fg-mute)' }}>
          There is no settings page at <code>{pathname}</code> here.
        </p>
      )}
    </SettingsLayout>
  );
}
