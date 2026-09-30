/**
 * The operator's GLOBAL KEYBOARD SHORTCUTS, as a kit a second host mounts
 * (portal-global-shortcuts-2026-09-06 P-001).
 *
 * The desktop binds every shortcut through ONE window-level keydown listener
 * (`GlobalShortcutDispatcher`, mounted once in
 * apps/operator-vite/src/routes/__root.tsx) that walks the resolved keymap of
 * packages/operator-core/lib/shortcut-registry.ts and runs whatever component
 * registered a handler for the matched id via `useShortcutAction`. The
 * components that own the app-wide bindings — history back/forward, the
 * cheat sheet, find-in-page, global search — are mounted beside it at the
 * router root.
 *
 * A host that mounts the operator's SURFACES (`../surfaces`) but not that
 * dispatcher renders the settings/shortcuts page and the cheat sheet with 25
 * bindings that never fire — measured on the cloud portal (:3081), which
 * hand-rolled ⌘K/⌘J and nothing else (EI-22480951817267572). This module is
 * the same composition-only shape as `../surfaces`: each export names the
 * component the operator ALREADY renders, so both hosts dispatch the same
 * registry through the same bus and a new binding lands in both at once.
 *
 * THREE EXPORTS, TWO WEIGHTS
 *   - `OperatorShortcutDispatcher` + `useShortcutAction` are EAGER: the
 *     dispatcher is the listener itself (registry + bus, no UI), and the hook
 *     is what the host's own chrome binds its ids with (`palette.toggle`,
 *     `panel.quick`, `goto.*`, …). Both must be live from first paint so a
 *     chord pressed before the lazy chunk resolves still lands.
 *   - `OperatorShortcutSurfaces` is LAZY: the cheat sheet (radix dialog), the
 *     find bar (react-css-highlight) and the search dialog are UI a host pays
 *     for only once mounted, on the same chunk-boundary reasoning as the
 *     surfaces table.
 *
 * DELIBERATELY NOT HERE — the root components whose behaviour is host
 * navigation or desktop-only:
 *   - GlobalAppShortcuts pushes operator PATHS (`/settings`, `/adv?opcv=inbox`,
 *     `/adv?create=true`); a host owns its own navigation and binds those ids
 *     itself (the portal maps them to its rail apps / panels — D-003).
 *   - GlobalCommandPalette is the operator's cmdk palette; the portal's
 *     `palette.toggle` is its app launcher.
 *   - GlobalVoiceShortcuts drives the desktop voice session, which a browser
 *     host does not run; the ids fall through inert (D-004).
 *
 * WHAT A HOST OWES THESE: a nuqs adapter above them (the dialogs' open state
 * is URL state) and the router-compat + `@/` build aliases the surfaces already
 * need (GlobalSearchDialog and RouteLink navigate through `lib/router-compat`).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
// The find bar's rules. The operator loads them from operator-vite's __root; a
// host reaches the bar only through this module, so the stylesheet rides here
// (the cheat-sheet rules ride with their component — see ShortcutsCheatSheet).
import '../../../../apps/operator/app/find-in-page.css';

export { default as OperatorShortcutDispatcher } from '../../../../apps/operator/app/_components/GlobalShortcutDispatcher';
export { useShortcutAction, useShortcutOverrides } from '../../../../apps/operator/lib/hotkeys';
export type { ActionOptions } from '../../../../apps/operator/lib/hotkeys';

/**
 * The app-wide keyboard UI, in the order the operator's own root mounts it:
 * history navigation, the `shortcuts.show` cheat sheet, the `find.open` bar,
 * the `search.global` dialog. One lazy chunk — a host renders it under its own
 * `<Suspense fallback={null}>`.
 */
export const OperatorShortcutSurfaces: LazyExoticComponent<ComponentType<Record<string, never>>> = lazy(
  async () => {
    const [nav, help, find, search] = await Promise.all([
      import('../../../../apps/operator/app/_components/GlobalNavShortcuts'),
      import('../../../../apps/operator/app/_components/GlobalShortcutsHelp'),
      import('../../../../apps/operator/app/_components/GlobalFindInPage'),
      import('../../../../apps/operator/app/_components/GlobalSearchDialog'),
    ]);
    const Nav = nav.default;
    const Help = help.default;
    const Find = find.default;
    const Search = search.default;
    return {
      default: () => (
        <>
          <Nav />
          <Help />
          <Find />
          <Search />
        </>
      ),
    };
  },
);
