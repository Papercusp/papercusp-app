/**
 * HarnessDock — Papercusp adapter around the shared @papercusp/dock-workbench
 * DockWorkspace.
 *
 * The generic package owns dockview hydration, persistence, layout schema,
 * panel bridging, and reset/load events. This adapter keeps the app-specific
 * behavior: plugin panels, close guards, keyboard shortcuts, focused-panel
 * tracking, iframe teardown, and the global dock-actions API binding.
 */

'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { DockWorkspace, createFetchDockLayoutStore, type DockLayoutRow, type DockLayoutStore } from '@papercusp/dock-workbench';
import { fetchSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { beginInteraction, endInteraction, PERF_INTERACTIONS } from '@/app/_components/perf/perf-marks';
import './dock-drawer-guard.css';
import { MissingPanel } from './MissingPanel';
import { bindDockApi } from './dock-actions';
import { canClosePanel, configureCloseGuard } from './close-guard';
import { useNavShortcuts } from './useNavShortcuts';
import { useLayoutResetShortcut } from './useLayoutResetShortcut';
import { useRegisterPluginPanels } from './useRegisterPluginPanels';
import { useFocusedPanelTracker } from './useFocusedPanelTracker';
import { destroy as destroyIframe } from './iframe-host';
import { useConfirmDialog } from '../useConfirmDialog';

interface HarnessDockProps {
  /**
   * Initial PG-backed layout name. e.g. 'default', 'dashboard:sheets'.
   * Agent dispatch via `loadLayout(name)` swaps this at runtime via a
   * window CustomEvent; the dock re-hydrates from the new layout.
   */
  layoutName: string;
  /** Optional className on the dockview root for theming. */
  className?: string;
  /**
   * Optional slug used to fetch + register plugin panels via
   * /api/plugins?slug=<slug>. Required if the layout references `plugin:*`.
   */
  slug?: string;
}

/**
 * The dock-layout HTTP routes resolve the workspace from the request's `?ws=`
 * param, falling back to `PAPERCUSP_WORKSPACE_ID ?? 'default'` — and that env
 * var is NOT set on the operator. Reads, by contrast, go through the
 * `dockLayouts.byName` sync query, which is scoped by an explicit `workspaceId`
 * ARG. So a store built without `?ws=` reads this workspace's row and writes
 * `default`'s: saves and resets return 2xx while the row the UI reads never
 * changes, with no error to attribute it to (EI-19425275400158684 — this is why
 * a dock stuck on retired panel types could not be recovered even with the
 * "Reset layout" button).
 */
const makeLayoutStore = (workspaceId: string) =>
  createFetchDockLayoutStore('/api/dock-layouts', { searchParams: () => ({ ws: workspaceId }) });

/**
 * Panel types that may still be registered AFTER hydration, so the dock's
 * dead-layout guard must never treat them as retired.
 *
 * `plugin:<name>:<id>` panels are registered by useRegisterPluginPanels once
 * `/api/plugins` resolves — its §8.3 hot-swap contract is precisely that a
 * layout referencing an unloaded plugin renders MissingPanel and then swaps in
 * the real component when the registration lands. So an unregistered `plugin:*`
 * type is the EXPECTED cold-start state, not evidence of a dead layout: without
 * this exemption a slow plugin fetch would reseed a perfectly good layout.
 *
 * Module scope keeps the identity stable across renders (the prop is a memo dep).
 */
const isDeferredPanelType = (type: string): boolean => type.startsWith('plugin:');

export function HarnessDock({ layoutName, className, slug }: HarnessDockProps) {
  const workspaceId = useWorkspaceId();
  const layoutStore = useMemo<DockLayoutStore>(() => ({
    ...makeLayoutStore(workspaceId),
    async load(name) {
      const rows = await fetchSyncQuery<DockLayoutRow>({
        queryName: 'dockLayouts.byName',
        args: { workspaceId, name },
        staleTime: 30_000,
      });
      if (!rows[0]) throw new Error(`layout ${name} not found`);
      return rows[0];
    },
  }), [workspaceId]);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Perf-marks (P-006): begin the harness-dock-open interaction on first mount;
  // the matching endInteraction fires in onApiReady, when DockWorkspace has
  // hydrated the PG layout and bound the dockview API. The measure spans dock
  // mount → dock live (layout load + dockview mount + panel creation) — the
  // dock-hydration cost.
  //
  // MUST be a LAYOUT effect, not a passive one (WI-7021 / EI-19375505819043214
  // class of bug — see perf-marks.ts's "WHERE TO PUT THE BEGIN" doc comment).
  // endInteraction fires from onApiReady, which DockviewReact's own vendored
  // `React.useEffect(() => { ...; props.onReady({ api }); }, [])` invokes as a
  // PASSIVE effect of a component several levels below this one in the tree
  // (DockviewReact, inside DockWorkspace, inside this component). React runs
  // passive effects child-before-parent within a commit, so with begin also in
  // a passive effect, DockviewReact's mount effect (child) fires BEFORE this
  // component's own mount effect (parent) — endInteraction runs first, with no
  // start mark yet written, and silently no-ops (perf-marks.ts's "SILENT ZERO"
  // failure mode). The begin's mark is then written a moment later with nothing
  // left to ever consume it: harness-dock-open never emits a measure, on any
  // route, regardless of how genuinely the dock mounted. ALL layout effects
  // across the whole tree run before ANY passive effect, so a layout-effect
  // begin here is guaranteed to precede DockviewReact's passive onReady effect.
  useLayoutEffect(() => {
    beginInteraction(PERF_INTERACTIONS.harnessDockOpen);
  }, []);

  useEffect(() => {
    configureCloseGuard({
      confirm: () =>
        askConfirm({
          title: 'Discard unsaved changes?',
          body: 'This panel has unsaved changes. Close it anyway?',
          confirmLabel: 'Close panel',
          destructive: true,
        }),
    });
  }, [askConfirm]);

  useNavShortcuts();
  useLayoutResetShortcut(() => {
    window.dispatchEvent(new CustomEvent('papercusp:dock-reset-layout'));
  });
  useRegisterPluginPanels(slug ?? '');
  useFocusedPanelTracker();

  const onApiReady = useCallback((api: Parameters<typeof bindDockApi>[0]) => {
    bindDockApi(api);
    // Dock is live (layout hydrated + API bound) — close the harness-dock-open
    // measure begun on mount. No-op unless a matching begin ran (measure-once).
    endInteraction(PERF_INTERACTIONS.harnessDockOpen);
  }, []);

  const onApiDispose = useCallback(() => {
    bindDockApi(null);
  }, []);

  const onPanelRemoved = useCallback((panelId: string) => {
    try {
      destroyIframe(panelId);
    } catch {
      /* destroy is idempotent; absorb errors */
    }
  }, []);

  return (
    <>
      {confirmEl}
      <DockWorkspace
        layoutName={layoutName}
        store={layoutStore}
        className={className ?? 'dockview-theme-dark'}
        missingComponent={MissingPanel}
        canClosePanel={canClosePanel}
        isDeferredPanelType={isDeferredPanelType}
        onApiReady={onApiReady}
        onApiDispose={onApiDispose}
        onPanelRemoved={onPanelRemoved}
        resetEventName="papercusp:dock-reset-layout"
        loadEventName="papercusp:dock-load-layout"
      />
    </>
  );
}
