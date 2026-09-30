/**
 * The PUBLIC TYPE SURFACE of `@papercusp/operator-ui/surfaces`, declared
 * without importing the operator components it mounts (WI-2143109).
 *
 * WHY A HAND-WRITTEN .d.ts RATHER THAN LETTING TSC INFER FROM index.tsx
 *
 * `index.tsx` lazily imports ~465 modules living in `apps/operator/app` and
 * `apps/operator-vite/src`. Those modules are written against the OPERATOR's
 * tsconfig — its `@/*` path mapping, its `lib`, its `types`, its strictness.
 * A consumer that follows the implementation therefore pulls that whole tree
 * into ITS program under ITS settings, which produces two bad outcomes and no
 * good one:
 *
 *   - hundreds of resolution errors that are artifacts of the consumer's
 *     config, not defects (measured: 625 errors in the portal, dominated by
 *     `Cannot find module '@/...'` — a path the operator's own build resolves
 *     perfectly well); and
 *   - a second, slower, differently-configured typecheck of code that is
 *     ALREADY typechecked where it lives, by `lint:tsc`'s operator legs and
 *     operator-vite's own `tsc`. Re-checking it here adds no safety.
 *
 * So the boundary is deliberate: the IMPLEMENTATION is typechecked in the repo
 * that owns it; CONSUMERS get this declaration. That is the ordinary contract
 * of a package, and it is what `exports["./surfaces"].types` points at.
 *
 * ⚠ THE COST, STATED PLAINLY: this file is hand-maintained, so it can drift
 * from `index.tsx` — the classic hand-maintained-metadata failure. Two things
 * bound that. It is TINY and shape-stable (a key union plus one uniform
 * component type — every entry is a zero-prop mount BY CONSTRUCTION, which is
 * why per-surface props are bound inside the table rather than exposed here).
 * And a drifted key is not silent: `isOperatorSurfaceKind` and
 * `OPERATOR_SURFACES` are declared over the SAME union, so a kind added to one
 * and not the other fails at the call site.
 */
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * The portal mounts that resolve to an operator component.
 *
 * Nine are rail surfaces (the former `mount: "embedded-pane"` iframes);
 * `tasks-roster` is the topbar process popover. Keep in sync with the table in
 * `index.tsx` — see the drift note above.
 */
export type OperatorSurfaceKind =
  | 'tasks-roster'
  | 'session-history'
  | 'desktops'
  | 'plans'
  | 'inbox'
  | 'overview'
  | 'hud'
  | 'work'
  | 'learning'
  | 'workflows'
  | 'brainstorm'
  // The remaining /adv tab bodies (portal-parity-adv-tabs-2026-09-05 D-004;
  // renamed where the portal already owns the name — D-005 / D-006).
  | 'health'
  | 'prs'
  | 'insights'
  | 'conversations'
  | 'adv-settings'
  | 'docs'
  | 'history'
  | 'git'
  | 'stats'
  | 'testing'
  | 'create'
  | 'scheduled'
  | 'frames'
  | 'evals'
  // /coord — the multi-agent coordination dashboard (portal-parity-adv-tabs-2026-09-05 P-004).
  | 'coord'
  // The operator top-nav's utility destinations (portal-parity D-007 / D-009).
  | 'cloud'
  | 'cupboard'
  | 'dev'
  | 'support'
  | 'settings'
  // The desktop's global-shortcut palette, mounted by the portal as its `quick`
  // shell panel (portal-quick-panel-palette-2026-09-06 D-001).
  | 'quick-panel';

/**
 * Every operator /adv tab id → the surface kind that mounts its body. Complete
 * over the operator's `ADV_TAB_IDS` by construction (typed over that union in
 * the implementation); declared with a string key here because the tab-id
 * union lives in the operator tree this declaration deliberately does not import.
 */
export declare const ADV_TAB_SURFACE_KINDS: Readonly<Record<string, OperatorSurfaceKind>>;

/** The /adv tab a surface kind mounts the body of, or `undefined` for a kind that is not an ADV tab body. */
export declare function advTabForSurface(kind: string): string | undefined;

/**
 * Every surface is a zero-prop lazy mount. Surfaces that need arguments
 * (`layout="split"`, `panel="brainstorm"`, `active`) have them bound inside the
 * table, so a host never has to know which is which — and `Record<string,
 * never>` states that: passing props here is a type error, not a silent no-op.
 */
export declare const OPERATOR_SURFACES: Record<
  OperatorSurfaceKind,
  LazyExoticComponent<ComponentType<Record<string, never>>>
>;

/** Narrow an arbitrary rail kind to one that has a surface behind it. */
export declare function isOperatorSurfaceKind(kind: string): kind is OperatorSurfaceKind;

/**
 * The pot scope a host wraps the /adv tab bodies in (portal-parity D-008 /
 * P-006): `Provider` supplies `useAdvScope()` and mounts the create/share
 * modals; `PotBar` is the operator's pot selector row. Mount as
 * `<Provider><PotBar withStatus={…}/><Surface/></Provider>` for every kind
 * `potScopeForSurface` reports `show:true`.
 */
export declare const OPERATOR_POT_SCOPE: {
  readonly Provider: LazyExoticComponent<ComponentType<{ children?: import('react').ReactNode }>>;
  readonly PotBar: LazyExoticComponent<ComponentType<{ withStatus?: boolean }>>;
};

/** Whether a surface kind is a pot-scoped /adv tab body, and whether its pot bar carries the status pills. */
export declare function potScopeForSurface(kind: string): { show: boolean; withStatus: boolean };
