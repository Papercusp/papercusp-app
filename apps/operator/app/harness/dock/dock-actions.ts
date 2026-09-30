/**
 * Agent + voice + command-palette dispatch surface for dock manipulation.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §9
 *
 * Bridge between agent `ui:dispatch` actions and the live DockviewApi.
 * The dock root binds setApi() on mount; callers (UI buttons, voice
 * handler, MCP tool, command palette) invoke the actions here.
 *
 * Reads (`ui:get_state` extensions §9.2) are also provided.
 */

'use client';

import type { DockviewApi } from 'dockview';
import { toLayoutDoc } from './layout-adapter';
import { panelRegistry } from './panel-registry';
import type { LayoutDoc } from '@papercusp/operator-core/lib/dock-layouts';

// ───────── Module-scoped api binding (singleton, set by HarnessDock) ─────────

let boundApi: DockviewApi | null = null;
const bindingListeners = new Set<(api: DockviewApi | null) => void>();

export function bindDockApi(api: DockviewApi | null): void {
  boundApi = api;
  for (const fn of bindingListeners) fn(api);
}

export function onDockApiBind(fn: (api: DockviewApi | null) => void): () => void {
  bindingListeners.add(fn);
  if (boundApi) fn(boundApi);
  return () => {
    bindingListeners.delete(fn);
  };
}

function api(): DockviewApi {
  if (!boundApi) {
    throw new Error('dock not mounted: no DockviewApi bound');
  }
  return boundApi;
}

// ───────── Actions (§9.1) ─────────

export interface OpenPanelArgs {
  /** Panel registry key. */
  type: string;
  /** Panel params. */
  params?: Record<string, unknown>;
  /** Optional explicit id; auto-generated if absent. */
  id?: string;
  /** Optional title override; falls back to registry meta or type. */
  title?: string;
  /** Group id to drop into; auto-positions if absent. */
  group?: string;
  /** If true, opens as a floating group instead of docking. */
  floating?: { x?: number; y?: number; width?: number; height?: number };
}

export function openPanel(args: OpenPanelArgs): string {
  const id = args.id ?? cryptoId('p');
  // Honor registry's keepAlive meta by setting dockview renderer='always'.
  // Without this, dockview unmounts inactive panels in a tab group on
  // every switch — losing scroll/state/intervals.
  const entry = panelRegistry.get(args.type);
  const renderer: 'always' | 'onlyWhenVisible' | undefined = entry?.meta.keepAlive
    ? 'always'
    : undefined;
  const opts: Parameters<DockviewApi['addPanel']>[0] = {
    id,
    component: args.type,
    title: args.title,
    params: args.params,
    ...(renderer ? { renderer } : {}),
  };
  if (args.group) {
    opts.position = { referenceGroup: args.group };
  }
  if (args.floating) {
    opts.floating = {
      x: args.floating.x ?? 80,
      y: args.floating.y ?? 80,
      width: args.floating.width ?? 480,
      height: args.floating.height ?? 360,
    };
  }
  api().addPanel(opts);
  return id;
}

export function focusPanel(panelId: string): boolean {
  const p = api().getPanel(panelId);
  if (!p) return false;
  p.api.setActive();
  return true;
}

export function closePanel(panelId: string): boolean {
  const p = api().getPanel(panelId);
  if (!p) return false;
  api().removePanel(p);
  return true;
}

export function setPanelParams(
  panelId: string,
  next: Record<string, unknown>,
): boolean {
  const p = api().getPanel(panelId);
  if (!p) return false;
  p.api.updateParameters(next);
  return true;
}

export function setPanelTitle(panelId: string, title: string): boolean {
  const p = api().getPanel(panelId);
  if (!p) return false;
  p.api.setTitle(title);
  return true;
}

/**
 * Group id of the first panel of `type`, or undefined if none is open.
 * Used to open a new panel INTO an existing region (e.g. drop the plan
 * editor into the preview's group so it swaps full-width in the right
 * region) via openPanel({ group }).
 */
export function groupIdOfPanelType(type: string): string | undefined {
  const dv = api();
  const p = dv.panels.find((pp) => panelType(pp) === type);
  return p?.group?.id;
}

/**
 * §9.1: agent-dispatchable layout-level actions.
 *
 * - `setFocusSlug(slug)` updates ?focusSlug= via nuqs from the URL
 *   directly (no nuqs-hook scope here). Best-effort; fails silently if
 *   the page isn't using nuqs.
 * - `loadLayout(name)` and `resetLayout()` are best handled by the
 *   useDockLayout hook in the mounting component; bridge them here by
 *   firing a custom DOM event the HarnessDock listens for.
 */

export function setFocusSlug(slug: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (slug) {
      url.searchParams.set('focusSlug', slug);
    } else {
      url.searchParams.delete('focusSlug');
    }
    // nuqs patches history.replaceState to broadcast URL updates to
    // useQueryState subscribers; no manual popstate dispatch needed.
    window.history.replaceState({}, '', url.toString());
  } catch {
    // Best-effort.
  }
}

/**
 * Emit a request for the mounting HarnessDock to load a named layout.
 * The dock listens on `window` for `papercusp:dock-load-layout` and
 * swaps via useDockLayout.
 */
export function loadLayout(name: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('papercusp:dock-load-layout', { detail: { name } }),
  );
}

export function resetLayout(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('papercusp:dock-reset-layout'));
}

// ───────── Reads (§9.2) ─────────

export interface PanelSnapshot {
  id: string;
  type: string;
  title: string | undefined;
  params: Record<string, unknown>;
  /** True if this panel is currently the active one in its group. */
  isActive: boolean;
}

// dockview's runtime IDockviewPanel doesn't expose contentComponent
// directly; it's available via toJSON(). For multi-panel listing,
// calling toJSON() per panel is wasteful, so we read via the (private)
// `view.contentComponent` field as a fallback.
function panelType(p: unknown): string {
  const cast = p as {
    view?: { contentComponent?: string };
    contentComponent?: string;
    component?: string;
    toJSON?: () => { contentComponent?: string };
  };
  if (cast.view?.contentComponent) return cast.view.contentComponent;
  if (cast.contentComponent) return cast.contentComponent;
  if (cast.component) return cast.component;
  try {
    const j = cast.toJSON?.();
    if (j?.contentComponent) return j.contentComponent;
  } catch {
    /* ignore */
  }
  return 'unknown';
}

export function listPanels(): PanelSnapshot[] {
  const dv = api();
  return dv.panels.map((p) => {
    const params = (p.params ?? {}) as Record<string, unknown>;
    const isActive = p.group?.activePanel?.id === p.id;
    return {
      id: p.id,
      type: panelType(p),
      title: p.title,
      params,
      isActive,
    };
  });
}

export function getFocusedPanel(): PanelSnapshot | null {
  const dv = api();
  const active = dv.activeGroup?.activePanel;
  if (!active) return null;
  return {
    id: active.id,
    type: panelType(active),
    title: active.title,
    params: (active.params ?? {}) as Record<string, unknown>,
    isActive: true,
  };
}

export function getLayoutSnapshot(): LayoutDoc {
  const dv = api();
  const json = dv.toJSON() as unknown as Parameters<typeof toLayoutDoc>[0];
  return toLayoutDoc(json);
}

// ───────── Utility ─────────

function cryptoId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return `${prefix}-${(crypto as Crypto).randomUUID().slice(0, 8)}`;
    }
  } catch {}
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
