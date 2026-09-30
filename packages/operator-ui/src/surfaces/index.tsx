/**
 * The nine operator CENTRE surfaces, as importable React components
 * (WI-2143109).
 *
 * WHY A FAÇADE HERE AND A PHYSICAL MOVE FOR AccountsTab
 * ----------------------------------------------------
 * AccountsTab was `git mv`'d into this package: 494 self-contained lines whose
 * only ties to the operator app were the three seams in `../seam`. Moving it
 * left ONE copy, and the operator re-exports it.
 *
 * These nine are a different shape and the same rule produces a different
 * answer. Measured (2026-09-03) their union is 465 runtime modules and 42
 * stylesheets spread across `apps/operator/app`, `apps/operator-vite/src` and
 * `packages/operator-core/lib`, wired together with the operator's `@/` alias.
 * Physically moving that closure would not "extract a panel" — it would move
 * most of the operator app into a package, rewrite ~465 files' import paths,
 * and leave the operator importing its own screens back through a package
 * boundary. The duplication rule that justified moving AccountsTab is the same
 * rule that forbids it here: one source of truth, and these files already have
 * one.
 *
 * So this module is composition only. Each entry names the component the
 * operator route ALREADY renders for that tab, so the portal mounts the very
 * same tree the operator does — no fork, no reimplementation, and a change to
 * a surface lands in both apps at once. The mapping below is the portal-side
 * mirror of `apps/operator-vite/src/routes/adv/index.tsx`'s tab switch plus the
 * `/plans`, `/inbox` and `/cloud-workspaces` route components.
 *
 * WHAT A HOST OWES THESE SURFACES (more than AccountsTab needed)
 *   1. configureOperatorUi({ Link, toast, apiFetch })   — ../seam
 *   2. a nuqs adapter above them  (74 of the 465 modules read URL state)
 *   3. a SyncProvider above them  (84 modules read through @papercusp/sync)
 *   4. build aliases for `@/` + `@papercusp/operator-core`, and the browser
 *      shims operator-vite already declares in its vite.config `resolve.alias`
 *      (without the `delegated-tasks` shim in particular, a runtime-guarded
 *      dynamic import drags ~1,900 server modules and node:fs into the graph —
 *      measured: PlansPane 2,165 modules shimless vs 220 with).
 *
 * Every entry is `lazy()` ON PURPOSE. The nine closures overlap but are far
 * from equal (20 modules for Desktops, 255 for HUD), and a portal tab must not
 * pay for the eight surfaces it is not showing. This preserves the same chunk
 * boundary the operator's own route-level code-splitting gives them.
 */
import { lazy, type ComponentProps, type ComponentType, type LazyExoticComponent } from 'react';
import '../../../../apps/operator/app/harness/harness.css';
// The DEV console's stylesheet. The operator loads it from `dev/layout.tsx`, a
// route-level layout a host never renders; it is namespaced (`.pc-dev-*`), so
// loading it once here — like harness.css above — costs nothing on the other
// surfaces and keeps the `dev` entry a zero-prop mount (portal-parity D-007).
import '../../../../apps/operator/app/dev/dev.css';
// `tasks-roster` imports TasksRosterPanel directly, bypassing both operator
// wrappers that normally carry this sheet (TasksRunningPill and
// TasksRosterEmbedRoute). Keep the panel's canonical rules on this host facade
// so every native OperatorSurface mount is styled without cloning them into the
// portal (portal design iteration P-008 / EI-22547277654420042).
import '../../../../apps/operator-vite/src/components/adv/adv-header-pills.css';
// The shared primitives (.pc-card/.pc-input/.pc-btn* and the element baselines) and
// the Settings/Support surface stylesheets, on the same reasoning: the operator
// loads them through globals.css / its route layouts, which a host never renders,
// so this index — the one mount contract every host goes through — carries them
// (portal-parity P-005/P-003, EI-22432328055190066). The
// apps/operator/app/_lints/mounted-surface-css guard fails when a mounted
// surface's class slides back into globals.css only.
import '../../../../apps/operator/app/_primitives.css';
import '../../../../apps/operator/app/settings/settings.css';
import '../../../../apps/operator/app/support/support.css';
// The token → grid palette bridge. Every grid-bearing surface below paints
// from grid-core's live palette, which is a neutral DARK set until this runs
// (portal-parity D-008 / P-012). The operator's main.tsx imports the same
// module; a host that mounts these surfaces gets it from here, by construction.
import '../grid-theme-bridge';
import { POT_BAR_TAB_IDS, potBarModeForTab } from '../../../../apps/operator-vite/src/components/adv/adv-pot-bar-tabs';
import type { AdvTabId } from '../../../../apps/operator-vite/src/components/adv/AdvShell';
import type { default as AdvHarnessPanelPage } from '../../../../apps/operator-vite/src/components/adv/AdvHarnessPanelPage';

/** The portal rail kinds that resolve to an operator surface. */
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
  // The remaining /adv tabs (portal-parity-adv-tabs-2026-09-05 D-004): EVERY
  // desktop ADV tab is a portal rail surface, on the owner's 2026-09-01 pattern
  // ("pull out the HUD, WORK and Learning tab like we did for the other tabs").
  // A kind reuses its ADV tab id except where the portal already owns that
  // name for a different surface (D-005 / D-006): the ADV `calendar` tab is the
  // scheduled-plans calendar → `scheduled` (the portal's `calendar` is the
  // Google-backed module); the ADV `plans` tab is the Create dock → `create`
  // (the portal's `plans` is the /plans pane); the ADV `settings` tab is the
  // per-pot harness settings panel → `adv-settings` (the portal's `settings` is
  // the operator's /settings surface below).
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
  // /coord — the multi-agent coordination dashboard (gap G2 of the parity
  // inventory; portal-parity-adv-tabs-2026-09-05 P-004). Not an ADV tab: a
  // route of its own in the operator, mounted here the same way.
  | 'coord'
  // The operator top-nav's utility destinations (portal-parity D-007 / D-009:
  // "the cloud cupboard and dev and support tabs should all be in the web
  // portal", and Settings is the operator's own settings surface).
  | 'cloud'
  | 'cupboard'
  | 'dev'
  | 'support'
  | 'settings'
  // The desktop's global-shortcut palette — /quick-panel: prompts | brainstorm |
  // docs (portal-quick-panel-palette-2026-09-06 D-001). Not a rail surface: the
  // portal mounts it as its `quick` shell PANEL, the way it models every popup.
  | 'quick-panel';

/**
 * The single-pot panels of `AdvHarnessPanelPage`. In the operator's /adv switch
 * `brainstorm | prs | insights | settings | docs | git | testing` all fall
 * through to that ONE page with `panel={tab}`; each portal kind binds its panel
 * here so the host still sees a zero-prop mount.
 */
type AdvHarnessPanel = ComponentProps<typeof AdvHarnessPanelPage>['panel'];
function harnessPanelSurface(panel: AdvHarnessPanel): LazyExoticComponent<ComponentType<Record<string, never>>> {
  return lazy(async () => {
    const mod = await import('../../../../apps/operator-vite/src/components/adv/AdvHarnessPanelPage');
    const Panel = mod.default;
    return { default: () => <Panel panel={panel} /> };
  });
}

/**
 * `Desktops` is the one surface with a SUBJECT (which workspace host to open).
 * The operator reads it from its own URL, so the portal passes it the same way
 * — through the nuqs adapter the host installs, not as a prop. That keeps this
 * table free of per-surface prop plumbing: every entry is a zero-prop mount.
 */
export const OPERATOR_SURFACES: Record<
  OperatorSurfaceKind,
  LazyExoticComponent<ComponentType<Record<string, never>>>
> = {
  'session-history': lazy(() => import('../../../../apps/operator/app/adv/sessions/SessionHistoryModal')),
  // The topbar process pill's roster. Not a rail surface — it is the popover
  // behind the process pill — but it is the same kind of thing (an operator
  // panel the portal framed) and it is the LAST iframe in the portal, so it
  // belongs in this table rather than in a parallel one-off mechanism.
  // `active` drives its inventory subscription; the popover only renders while
  // open, so it is always active.
  'tasks-roster': lazy(async () => {
    const mod = await import('../../../../apps/operator-vite/src/components/adv/TasksRosterPanel');
    const Panel = mod.default;
    return { default: () => <Panel active /> };
  }),
  // D-062: the desktop workspace is reachable directly, including without a host deep link.
  desktops: lazy(() => import('../../../../apps/operator/app/cloud-workspaces/DesktopWorkspacePage')),
  // /plans — PlansPane owns filters, dashboard nav and the cleanup strip.
  // `layout="split"` is the route's own choice, re-stated here so the portal
  // pane lays out list-beside-detail exactly as /plans does.
  plans: lazy(async () => {
    const mod = await import('../../../../apps/operator/app/_components/plans/PlansPane');
    // NO ChatRefPopupHost here (WI-10001509). It is a SINGLETON keyed on the
    // global `wpop`/`wppop` params, and every host now mounts it once at its
    // own root — the operator at its router root, the portal inside its
    // OperatorHostProvider. Mounting it per-surface as well would render one
    // param TWICE (a duplicate stacked popup), which is the exact failure
    // WI-6601's singleton was introduced to prevent.
    const Pane = mod.default;
    return { default: () => <Pane layout="split" /> };
  }),
  // /inbox — same split contract as /plans.
  inbox: lazy(async () => {
    const mod = await import('../../../../apps/operator/app/_components/inbox/InboxPane');
    const Pane = mod.default;
    return { default: () => <Pane layout="split" /> };
  }),
  // /adv?tab=<id> — the tab bodies from the adv route's switch
  // (apps/operator-vite/src/routes/adv/index.tsx `renderAdvTab`). Every one of
  // the 20 ADV tabs is here; `ADV_TAB_SURFACE_KINDS` below is the complete
  // tab → kind map and is typed over the full AdvTabId union, so a NEW desktop
  // tab fails to compile until it is registered for the portal too.
  overview: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvOverviewTab')),
  hud: lazy(() => import('../../../../apps/operator/app/adv/hud/HudView')),
  work: lazy(() => import('../../../../apps/operator/app/adv/harnesses/HarnessesWorkspace')),
  learning: lazy(() => import('../../../../apps/operator-vite/src/components/adv/LearningTab')),
  workflows: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvWorkflowsTab')),
  // The single-pot panels — see harnessPanelSurface above.
  brainstorm: harnessPanelSurface('brainstorm'),
  prs: harnessPanelSurface('prs'),
  insights: harnessPanelSurface('insights'),
  'adv-settings': harnessPanelSurface('settings'),
  docs: harnessPanelSurface('docs'),
  git: harnessPanelSurface('git'),
  testing: harnessPanelSurface('testing'),
  // Workspace-wide dashboards (no pot bar — see POT_BAR_TAB_IDS' "deliberately
  // absent" list): the read-only system Health dashboard, the swarm live view of
  // deployed frames, the impartial-benchmark Evaluation surface, the
  // Conversations aggregate, and the scheduled-plans Calendar (D-005).
  health: lazy(() => import('../../../../apps/operator-vite/src/components/adv/HealthTab')),
  frames: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvFramesTab')),
  evals: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvEvalsTab')),
  conversations: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvConversationsTab')),
  scheduled: lazy(() => import('../../../../apps/operator-vite/src/components/adv/ScheduledCalendarTab')),
  // Pot-scoped tabs with their own component: Stats (inherits the pot from
  // useAdvScope — its props are a test seam, so the zero-prop mount is the
  // operator's own default), the session History list, and the Create dock
  // (the ADV `plans` tab — D-006).
  stats: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvStatsTab')),
  history: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvHistoryTab')),
  create: lazy(() => import('../../../../apps/operator/app/adv/create/AdvCreateDock')),
  // /coord — the operator route renders <CoordDashboard /> and nothing else
  // (apps/operator-vite/src/routes/coord.tsx), so the dashboard IS the surface.
  coord: lazy(() => import('../../../../apps/operator/app/coord/CoordDashboard')),
  // The operator top-nav's utility set (portal-parity D-007 / D-009).
  // /cloud-workspaces — cloud lifecycle management, landing on its
  // default step: the operator's own "Cloud" nav target is this route.
  cloud: lazy(() => import('../../../../apps/operator/app/cloud-workspaces/page')),
  // /cupboard + /cupboard/$id — two operator routes behind one switch, keyed by
  // the `useParams().id` the detail page reads (the host's router shim supplies it).
  cupboard: lazy(() => import('../../../../apps/operator/app/cupboard/CupboardSurface')),
  // /dev — the console page itself; its tabs are nuqs state and its sub-routes
  // (/dev/gym, /dev/tokens, …) stay operator-origin links.
  dev: lazy(() => import('../../../../apps/operator/app/dev/page')),
  // /support — FAQ + support chat. Its RouteLinks resolve through the host's link shim.
  support: lazy(() => import('../../../../apps/operator/app/support/page')),
  // /settings/** — SettingsLayout around the sub-page the (virtual) pathname
  // selects; the sub-page table is pinned to the operator's route set by test.
  settings: lazy(() => import('../../../../apps/operator/app/settings/SettingsSurface')),
  // /quick-panel — the palette's tabbed body, bound for a host that mounts it
  // OVER another page rather than as the whole window:
  //   - no `headerSlot`: the vite route's "N POT / N agents" pills are the
  //     popup window's chrome and live under operator-vite;
  //   - `chatSidebar={false}`: the page's docked OperatorChatSidebar writes
  //     `--op-chat-w` on :root and `body.has-op-chat`, which would shift the
  //     host's whole page; the portal has its own chat dock;
  //   - `queryPrefix="qp"`: the page shares the host's URL, and its bare keys
  //     collide there (`q` is the portal's search box, `tab` belongs to the
  //     dev / cloud pages) — `?panel=quick&qptab=brainstorm&qpq=deploy`.
  'quick-panel': lazy(async () => {
    const mod = await import('../../../../apps/operator/app/quick-panel/page');
    const Page = mod.default;
    return { default: () => <Page chatSidebar={false} queryPrefix="qp" /> };
  }),
};

/** Whether a portal rail kind has a native operator surface behind it. */
export function isOperatorSurfaceKind(kind: string): kind is OperatorSurfaceKind {
  return kind in OPERATOR_SURFACES;
}

/**
 * The POT SCOPE a host must put around the /adv tab bodies (portal-parity
 * D-008 / P-006).
 *
 * In the operator, AdvShell provides `useAdvScope()` and each pot-scoped tab
 * body renders AdvPotBar (the pot selector + the "Create pot" / Share
 * affordances) above itself. A host that mounts a tab body WITHOUT that shell
 * gets the context default — `ready:false`, `hive:''` — so LearningTab's
 * hive-aware reads never fire (no retained learnings) and HarnessesWorkspace
 * asks the reader to pick a pot "from the selector above" with no selector
 * above. These two are the shell's scope, extracted so the host can mount them
 * alone: `<Provider><PotBar withStatus={…}/><Surface/></Provider>`.
 */
export const OPERATOR_POT_SCOPE = {
  Provider: lazy(async () => {
    const mod = await import('../../../../apps/operator-vite/src/components/adv/AdvShell');
    return { default: mod.AdvScopeProvider };
  }),
  PotBar: lazy(() => import('../../../../apps/operator-vite/src/components/adv/AdvPotBar')),
} as const;

/**
 * Every /adv tab → the portal surface kind that mounts its body
 * (portal-parity-adv-tabs-2026-09-05 P-001). Typed over the FULL `AdvTabId`
 * union on purpose: adding a tab to the desktop's `ADV_TAB_IDS` without a
 * portal kind is a compile error here, not a silent parity gap. The operator's
 * own `POT_BAR_TAB_IDS` then decides whether a kind's body gets the pot bar, so
 * this table cannot disagree with the operator about scope.
 */
import { ADV_TAB_SURFACE_KINDS as SHARED_ADV_TAB_SURFACE_KINDS } from '../adv-navigation';
export const ADV_TAB_SURFACE_KINDS: Readonly<Record<AdvTabId, OperatorSurfaceKind>> = SHARED_ADV_TAB_SURFACE_KINDS;

/** The inverse of ADV_TAB_SURFACE_KINDS — derived, so the two cannot drift. */
const SURFACE_KIND_TO_ADV_TAB: ReadonlyMap<OperatorSurfaceKind, AdvTabId> = new Map(
  (Object.entries(ADV_TAB_SURFACE_KINDS) as [AdvTabId, OperatorSurfaceKind][]).map(([tab, kind]) => [kind, tab]),
);

/** The /adv tab a surface kind mounts the body of, or `undefined` for a kind that is not an ADV tab body. */
export function advTabForSurface(kind: string): AdvTabId | undefined {
  return SURFACE_KIND_TO_ADV_TAB.get(kind as OperatorSurfaceKind);
}

/** The pot bar mode for a surface kind — `{ show:false }` for every kind that is not a pot-scoped /adv tab. */
export function potScopeForSurface(kind: string): { show: boolean; withStatus: boolean } {
  const tab = advTabForSurface(kind);
  if (!tab || !POT_BAR_TAB_IDS.has(tab)) return { show: false, withStatus: false };
  return potBarModeForTab(tab);
}
