import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import { collectPanelTypes, isLayoutEntirelyUnregistered, isWellFormedLayout, type LayoutDoc } from './layout';
import { toDockviewJson, toLayoutDoc, type DockviewLayout } from './layout-adapter';
import { panelRegistry as defaultRegistry, type PanelComponent, type PanelComponentProps, type PanelRegistry } from './panel-registry';
import { DockLayoutConflictError, type DockLayoutStore } from './store';
import { useDockLayout } from './useDockLayout';

export interface DockWorkspaceProps {
  layoutName: string;
  store: DockLayoutStore;
  registry?: PanelRegistry;
  className?: string;
  resetEventName?: string;
  loadEventName?: string;
  missingComponent?: PanelComponent;
  canClosePanel?: (panelId: string) => Promise<boolean> | boolean;
  /**
   * Declares which panel types may still be registered LATER (e.g. plugins
   * fetched at runtime), so the dead-layout guard never mistakes a
   * not-yet-loaded panel for a retired one. See
   * `isLayoutEntirelyUnregistered` — omitting this makes the guard STRICTER,
   * never looser, so a host with only static panels needs nothing here.
   *
   * Must be referentially stable (module scope / useCallback); a fresh arrow
   * each render re-runs the guard's memo every commit.
   */
  isDeferredPanelType?: (type: string) => boolean;
  onApiReady?: (api: DockviewApi) => void;
  onApiDispose?: () => void;
  onPanelRemoved?: (panelId: string) => void;
  onSaveError?: (error: Error) => void;
  renderError?: (error: Error, actions: { retry: () => void; reset: () => void }) => ReactElement;
}

function DefaultMissingPanel({ panelType }: PanelComponentProps) {
  return (
    <div style={{ padding: 12, color: 'var(--fg-mute, #888)', font: '12px system-ui, sans-serif' }}>
      Missing panel: <code>{panelType}</code>
    </div>
  );
}

function makeBridge(type: string, registry: PanelRegistry, Missing: PanelComponent, canClose?: DockWorkspaceProps['canClosePanel']) {
  function Bridge(dvProps: IDockviewPanelProps<Record<string, unknown>>) {
    const { api, params } = dvProps;
    const panelProps: PanelComponentProps = useMemo(
      () => ({
        panelId: api.id,
        panelType: type,
        params: (params ?? {}) as Record<string, unknown>,
        api: {
          setParams: (next) => api.updateParameters(next),
          setTitle: (t) => api.setTitle(t),
          close: () => {
            Promise.resolve(canClose ? canClose(api.id) : true).then((ok) => {
              if (ok) api.close();
            });
          },
        },
      }),
      [api, params],
    );

    const entry = registry.get(type);
    const Real = entry?.component ?? Missing;
    return <Real {...panelProps} />;
  }
  Bridge.displayName = `PanelBridge(${type})`;
  return Bridge;
}

/**
 * How long the dead-layout guard waits before reseeding. Covers registrations
 * that land in an ancestor's mount effect (React runs child effects first), so
 * the guard cannot fire on a layout that was about to become renderable.
 */
const DEAD_LAYOUT_RESEED_GRACE_MS = 300;

/**
 * Re-renders on every registry mutation. Owned HERE rather than inside
 * `useComponentsForLayout` because the dead-layout guard needs the same signal:
 * one subscription feeding both keeps them evaluating the same registry state.
 */
function useRegistryVersion(registry: PanelRegistry): number {
  const [tick, setTick] = useState(0);
  useEffect(() => registry.subscribe(() => setTick((t) => t + 1)), [registry]);
  return tick;
}

function useComponentsForLayout(
  layout: LayoutDoc | null,
  registry: PanelRegistry,
  Missing: PanelComponent,
  canClose: DockWorkspaceProps['canClosePanel'] | undefined,
  registryTick: number,
): Record<string, PanelComponent> {
  return useMemo(() => {
    void registryTick;
    const types = layout ? collectPanelTypes(layout) : new Set<string>();
    for (const t of registry.list()) types.add(t);
    types.add('__missing__');
    const map: Record<string, PanelComponent> = {};
    for (const t of types) {
      map[t] = makeBridge(t, registry, Missing, canClose) as unknown as PanelComponent;
    }
    return map;
  }, [layout, registry, registryTick, Missing, canClose]);
}

export function DockWorkspace({
  layoutName: initialLayoutName,
  store,
  registry = defaultRegistry,
  className,
  resetEventName,
  loadEventName,
  missingComponent = DefaultMissingPanel,
  canClosePanel,
  isDeferredPanelType,
  onApiReady,
  onApiDispose,
  onPanelRemoved,
  onSaveError,
  renderError,
}: DockWorkspaceProps) {
  const [activeLayoutName, setActiveLayoutName] = useState(initialLayoutName);
  useEffect(() => setActiveLayoutName(initialLayoutName), [initialLayoutName]);

  const { state, save, reset, refresh } = useDockLayout(activeLayoutName, store);
  const apiRef = useRef<DockviewApi | null>(null);
  const restoredOnceRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rawLayout = state.status === 'ready' && state.row.schemaVersion === 1 ? (state.row.layoutJson as LayoutDoc) : null;
  const layoutDoc = isWellFormedLayout(rawLayout) ? rawLayout : null;
  const malformedRow = rawLayout !== null && layoutDoc === null;
  const registryTick = useRegistryVersion(registry);
  const components = useComponentsForLayout(layoutDoc, registry, missingComponent, canClosePanel, registryTick);

  // ───────── Dead-layout guard ─────────
  // A persisted row can outlive the panels it references (types retired from a
  // later build), and a persisted row WINS over the seed — so the dock hydrates
  // a wall of "not installed" placeholders with no usable pane, and the only way
  // out is a reset button the user has to know exists. Detect that and reseed.
  //
  // Recovery is `reset()` — the SAME path the reset event uses — so the fix
  // shares the host's seed rather than inventing a second notion of "default",
  // and it HEALS the stored row instead of re-deciding this on every load.
  const layoutIsDead = useMemo(() => {
    void registryTick; // re-evaluate as registrations land
    return layoutDoc !== null && isLayoutEntirelyUnregistered(layoutDoc, (t) => registry.has(t), isDeferredPanelType);
  }, [layoutDoc, registry, registryTick, isDeferredPanelType]);

  const reseededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!layoutIsDead || !layoutDoc) return;
    // Once per layout name per mount. A seed that is ITSELF unrenderable must
    // not spin: one attempt, then live with the placeholders.
    if (reseededRef.current === activeLayoutName) return;
    const deadTypes = [...collectPanelTypes(layoutDoc)].join(', ');
    // Grace window: static registrations can land in an ANCESTOR's mount effect,
    // which React runs AFTER this child's. Waiting lets those settle — if any
    // arrives, `layoutIsDead` flips false and this effect's cleanup cancels the
    // reseed before it ever fires.
    const t = setTimeout(() => {
      reseededRef.current = activeLayoutName;
      console.warn(
        `[DockWorkspace] layout "${activeLayoutName}" references only unrenderable panel types ` +
          `(${deadTypes}) — reseeding from the default layout.`,
      );
      restoredOnceRef.current = false;
      void reset().catch((err) => console.error('[DockWorkspace] dead-layout reseed failed:', err));
    }, DEAD_LAYOUT_RESEED_GRACE_MS);
    return () => clearTimeout(t);
  }, [layoutIsDead, activeLayoutName, layoutDoc, reset]);

  const recoveredTsRef = useRef<number | null>(null);
  useEffect(() => {
    if (!malformedRow || state.status !== 'ready') return;
    const ts = state.row.updatedTs;
    if (recoveredTsRef.current === ts) return;
    recoveredTsRef.current = ts;
    const t = setTimeout(() => void refresh(), 300);
    return () => clearTimeout(t);
  }, [malformedRow, state, refresh]);

  useEffect(() => {
    if (restoredOnceRef.current) return;
    if (!apiRef.current || !layoutDoc) return;
    try {
      apiRef.current.fromJSON(toDockviewJson(layoutDoc) as unknown as Parameters<DockviewApi['fromJSON']>[0]);
      restoredOnceRef.current = true;
    } catch (err) {
      console.error('[DockWorkspace] hydrate failed:', err);
    }
  }, [layoutDoc]);

  const persist = useCallback(() => {
    if (!apiRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const dv = apiRef.current?.toJSON() as unknown as DockviewLayout | undefined;
      if (!dv) return;
      const doc = toLayoutDoc(dv);
      if (!isWellFormedLayout(doc)) return;
      save(doc).catch((err: Error & { conflict?: boolean }) => {
        if (err instanceof DockLayoutConflictError || err.conflict) return;
        onSaveError?.(err);
        if (!onSaveError) console.warn('[DockWorkspace] save failed:', err.message);
      });
    }, 800);
  }, [save, onSaveError]);

  const [apiReady, setApiReady] = useState(false);
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      onApiReady?.(event.api);
      setApiReady(true);
    },
    [onApiReady],
  );

  useEffect(() => {
    if (!apiReady || !apiRef.current) return;
    const api = apiRef.current;
    const disposables = [
      api.onDidLayoutChange(persist),
      api.onDidAddPanel(persist),
      api.onDidRemovePanel((panel) => {
        persist();
        onPanelRemoved?.(panel.id);
      }),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [apiReady, persist, onPanelRemoved]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      onApiDispose?.();
    };
  }, [onApiDispose]);

  useEffect(() => {
    if (!resetEventName && !loadEventName) return;
    const onResetLayout = () => {
      restoredOnceRef.current = false;
      void reset().catch((err) => console.error('[DockWorkspace] reset failed:', err));
    };
    const onLoadLayout = (e: Event) => {
      const detail = (e as CustomEvent<{ name?: string }>).detail;
      if (detail?.name && typeof detail.name === 'string') {
        restoredOnceRef.current = false;
        setActiveLayoutName(detail.name);
      }
    };
    if (resetEventName) window.addEventListener(resetEventName, onResetLayout);
    if (loadEventName) window.addEventListener(loadEventName, onLoadLayout);
    return () => {
      if (resetEventName) window.removeEventListener(resetEventName, onResetLayout);
      if (loadEventName) window.removeEventListener(loadEventName, onLoadLayout);
    };
  }, [reset, resetEventName, loadEventName]);

  if (state.status === 'error') {
    const retry = () => void refresh();
    const resetLayout = () => {
      restoredOnceRef.current = false;
      void reset();
    };
    if (renderError) return renderError(state.error, { retry, reset: resetLayout });
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start', fontSize: 13 }}>
        <div style={{ color: 'var(--bad, #f85149)' }}>
          Failed to load layout <code>{activeLayoutName}</code>: {state.error.message}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={retry}>Retry</button>
          <button type="button" onClick={resetLayout}>Reset to default</button>
        </div>
      </div>
    );
  }

  return (
    <DockviewReact
      onReady={onReady}
      components={components as unknown as Parameters<typeof DockviewReact>[0]['components']}
      className={className ?? 'dockview-theme-dark'}
    />
  );
}
