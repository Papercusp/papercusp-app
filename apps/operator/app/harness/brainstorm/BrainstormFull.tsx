'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import dynamic from '@/lib/router-compat/dynamic';
import { Pencil, Network, PencilRuler } from 'lucide-react';
/* Three independent brainstorm surfaces, each with its own storage:
 *   - WriteView   → /api/harness/<slug>/brainstorm        (markdown)
 *   - CanvasView  → /api/harness/<slug>/brainstorm-canvas (excalidraw scene)
 *   - MapView     → /api/harness/<slug>/brainstorm-mindmap (mind-elixir tree)
 * They share a visual surface (z-stacked overlay) but no data. */

const WriteView = dynamic(() => import('./WriteView').then((m) => m.WriteView), { ssr: false });
const MapView = dynamic(() => import('./MapView').then((m) => m.MapView), { ssr: false });
const CanvasView = dynamic(() => import('./CanvasView').then((m) => m.CanvasView), { ssr: false });
const BrainstormChat = dynamic(() => import('./BrainstormChat'), { ssr: false });

type ActiveLayer = 'write' | 'map' | 'canvas';

const LAYERS: Array<{ id: ActiveLayer; icon: typeof Pencil; label: string; caption: string }> = [
  { id: 'write', icon: Pencil, label: 'write', caption: 'shape the spec in rich notes' },
  { id: 'map', icon: Network, label: 'map', caption: 'mindmap derived from headings' },
  { id: 'canvas', icon: PencilRuler, label: 'canvas', caption: 'sketch flows, branches, ideas' },
];

/**
 * All three views render simultaneously, stacked z-index, sharing one
 * #19232A surface. The user picks an "active layer" via the chip in the
 * top-right; only that layer takes pointer events.
 */
export function BrainstormFull({ slug }: { slug: string }) {
  const [active, setActive] = useQueryState(
    'brainstormTab',
    parseAsStringEnum<ActiveLayer>(['write', 'map', 'canvas']).withDefault('write'),
  );
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const activeMeta = useMemo(() => LAYERS.find((l) => l.id === active) ?? LAYERS[0], [active]);

  const workspacePanel = (
    <section
      className={`h-panel h-bsfull-panel primary h-bsfull-stacked active-${active}`}
      aria-label="Brainstorm workspace"
    >
      <div className="h-panel-head h-bsfull-head">
        <div className="h-bsfull-titleblock">
          <span className="h-panel-title">brainstorm workspace</span>
          <span className="h-bsfull-caption">{activeMeta.caption}</span>
        </div>
        <div className="h-bsfull-subtabs" role="tablist" aria-label="Active layer">
          {LAYERS.map((l) => (
            <Tooltip key={l.id} label={l.caption}><button

              type="button"
              role="tab"
              aria-selected={active === l.id}
              className={`h-bsfull-sub${active === l.id ? ' on' : ''}`}
              onClick={() => void setActive(l.id)}

            >
              <l.icon size={12} />
              <span>{l.label}</span>
            </button></Tooltip>
          ))}
        </div>
      </div>

      <BrainstormStackHost active={active} slug={slug} />
    </section>
  );

  const partnerPanel = (
    <section className="h-panel h-bsfull-panel partner" aria-label="Brainstorm partner">
      <div className="h-panel-head h-bsfull-head">
        <div className="h-bsfull-titleblock">
          <span className="h-panel-title">brainstorm partner</span>
          <span className="h-bsfull-caption">Claude keeps the thread warm while you explore.</span>
        </div>
        <span className="h-bsfull-live">ready</span>
      </div>
      <div className="h-bsfull-partner-body">
        <BrainstormChat slug={slug} />
      </div>
    </section>
  );

  return (
    <div className={`h-bsfull tool-${active}`}>
      {isCompact ? (
        <div className="h-bsfull-stack">
          {workspacePanel}
          {partnerPanel}
        </div>
      ) : (
        <div className="h-bsfull-grid">
          {workspacePanel}
          {partnerPanel}
        </div>
      )}
    </div>
  );
}

/**
 * Stacked layers — all three render simultaneously.
 *
 * Cross-layer contextmenu trap: Excalidraw registers a window-level
 * `contextmenu` listener to render its own context menu. When the
 * user right-clicks a mind-elixir node or BlockNote text, the native
 * event bubbles past the React tree to window and Excalidraw's menu
 * pops *in addition to* the active layer's menu (we observed both
 * `.excalidraw-contextMenuContainer` and `.context-menu` open at
 * once). React's `onContextMenu` runs at the React-root delegation
 * point, which is below window in the bubble path, so by the time
 * React's handler fires Excalidraw has already rendered its menu.
 *
 * Fix: a capture-phase native listener on the host that fires BEFORE
 * window-level handlers. If the contextmenu didn't originate inside
 * the *active* canvas layer, we suppress it via stopImmediatePropagation
 * + preventDefault so Excalidraw's window listener never sees it. The
 * active layer's own contextmenu (mind-elixir / BlockNote / Excalidraw
 * when it IS active) still fires because we don't stop propagation
 * within the active layer's own subtree.
 */
function BrainstormStackHost({ active, slug }: { active: ActiveLayer; slug: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  // When the active layer changes, blur whatever's focused inside the
  // *previous* layer. Without this, BlockNote's ProseMirror or a
  // mind-map rename input can keep document focus after the user has
  // switched to a different chip — keystrokes (Delete, Backspace,
  // Enter) then route to the now-invisible editor instead of the
  // active panel. CSS `pointer-events: none` blocks pointer input
  // but doesn't drop existing keyboard focus, so we do it manually.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || focused === document.body) return;
    const layer = focused.closest('.h-bsfull-layer');
    if (!layer) return;
    if (layer.classList.contains(`h-bsfull-layer-${active}`)) return;
    focused.blur();
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Bubble phase: by the time the event reaches the host on its way
    // up to window, every listener inside the originating layer
    // (mind-elixir on .map-container, BlockNote on .ProseMirror,
    // Excalidraw on .excalidraw when canvas IS active) has already
    // fired. We then stop propagation so Excalidraw's window-level
    // listener never sees events that didn't originate in the
    // canvas layer — which is what was double-firing the menu.
    const onCtx = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      const originLayer = target.closest('.h-bsfull-layer');
      if (!originLayer) return;
      const fromCanvas = originLayer.classList.contains('h-bsfull-layer-canvas');
      if (!fromCanvas) {
        e.stopPropagation();
      }
    };
    host.addEventListener('contextmenu', onCtx);
    return () => host.removeEventListener('contextmenu', onCtx);
  }, []);

  return (
    <div ref={hostRef} className="h-bsfull-stack-host">
      <div className="h-bsfull-layer h-bsfull-layer-canvas">
        <CanvasView slug={slug} />
      </div>
      <div className="h-bsfull-layer h-bsfull-layer-map">
        <MapView slug={slug} />
      </div>
      <div className="h-bsfull-layer h-bsfull-layer-write">
        <WriteView slug={slug} />
      </div>
    </div>
  );
}
