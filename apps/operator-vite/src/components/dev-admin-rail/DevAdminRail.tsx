/**
 * Dev admin rail (plan dev-admin-sidebar-2026-06-05) — a collapsible, DEV-ONLY
 * right rail that re-presents the URL-only /admin surfaces + SU dev glances as one
 * always-at-hand cockpit while working.
 *
 * It is DOCKED, not floating — it behaves like the left op-chat sidebar
 * (OperatorChatSidebar): always present, reserves layout space so the app shifts
 * left instead of being overlaid, collapses to a thin full-height expand-rail
 * (never a disappearing tab), and is drag-resizable from its left edge with the
 * width persisted to localStorage.
 *
 * Gating: this component is mounted only behind `import.meta.env.MODE !==
 * 'production'` (in __root.tsx, via a dev-gated lazy import) so it is ABSENT from
 * production / user builds — it never ships to users (D-001). MODE (not DEV) is
 * the gate because Vite ties DEV/PROD to the command, and the desktop dev shell
 * runs `vite build --mode development` (a build, so DEV===false) — see __root.tsx.
 * Don't add an unconditional import of it anywhere.
 *
 * State (D-005, per the nuqs-default): open/collapsed + the active accordion
 * section live in the URL (`?devRail=1&devSec=flags`), so the rail is deep-linkable
 * and agent-driveable (ui:get_state / ui:dispatch read/write the URL). Exactly one
 * section is open at a time; only the open section's body is mounted, and the whole
 * accordion is unmounted while collapsed, so an inactive panel's SSE/queries never
 * run.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
// Retry-wrapped lazy (WI-2902): a transient chunk fetch failure retries instead
// of escalating to the fatal route error boundary.
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { useQueryState, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { usePathname } from '@/lib/router-compat/navigation';
import { isChromelessPath } from '@papercusp/operator-core/lib/chromeless-routes';
import { useLexicon } from '@/lib/useLexicon';
import {
  Flag,
  Terminal,
  Bell,
  Activity,
  Rocket,
  Database,
  Users,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  BarChart3,
} from 'lucide-react';
import { RAIL_CSS } from './dev-admin-rail.styles';

// Heavy panels are lazy so opening the rail (not loading the app) pays for them.
const FlagsPanel = lazy(() => import('./panels/FlagsPanel'));
const RunPanel = lazy(() => import('./panels/RunPanel'));
const NotificationsPanel = lazy(() => import('./panels/NotificationsPanel'));
const ServiceHealthPanel = lazy(() => import('./panels/ServiceHealthPanel'));
const DeployStatePanel = lazy(() => import('./panels/DeployStatePanel'));
const DbHealthPanel = lazy(() => import('./panels/DbHealthPanel'));
const FleetPanel = lazy(() => import('./panels/FleetPanel'));
const ToolUsagePanel = lazy(() => import('./panels/ToolUsagePanel'));

const SECTIONS = [
  { id: 'flags', label: 'Feature flags', icon: Flag, render: () => <FlagsPanel /> },
  { id: 'run', label: 'Run', icon: Terminal, render: () => <RunPanel /> },
  { id: 'notifications', label: 'Notifications / errors', icon: Bell, render: (a: boolean) => <NotificationsPanel active={a} /> },
  { id: 'health', label: 'Service health', icon: Activity, render: (a: boolean) => <ServiceHealthPanel active={a} /> },
  { id: 'deploy', label: 'Deploy / release gate', icon: Rocket, render: (a: boolean) => <DeployStatePanel active={a} /> },
  { id: 'db', label: 'DB health', icon: Database, render: (a: boolean) => <DbHealthPanel active={a} /> },
  { id: 'fleet', label: 'Fleet / coord', icon: Users, render: (a: boolean) => <FleetPanel active={a} /> },
  { id: 'usage', label: 'Tool usage', icon: BarChart3, render: (a: boolean) => <ToolUsagePanel active={a} /> },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];
const SECTION_IDS = SECTIONS.map((s) => s.id) as unknown as SectionId[];

// Width model — mirrors operator-chat-layout.ts. Collapsed is a thin rail; the
// open panel drags from the collapsed width up to a viewport-relative ceiling.
const COLLAPSED_WIDTH = 48;
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 384;
const WIDTH_STORAGE_KEY = 'papercusp.devRail.width';

// Iframe-target / popup routes render no global chrome; the rail must be absent
// there too so it doesn't reserve space inside an embedded route. Shared list in
// lib/chromeless-routes (also gates __root chrome + LeftSidebar).

function widthCeiling(viewportWidth: number): number {
  return Math.max(MIN_WIDTH, Math.floor(viewportWidth * 0.6));
}

function clampWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(widthCeiling(viewportWidth), width));
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(wsLocalKey(WIDTH_STORAGE_KEY));
    if (!raw) return DEFAULT_WIDTH;
    return clampWidth(Number(raw), window.innerWidth);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function DevAdminRail() {
  const t = useLexicon();
  const [open, setOpen] = useQueryState('devRail', parseAsBoolean.withDefault(false));
  const [section, setSection] = useQueryState(
    'devSec',
    parseAsStringLiteral(SECTION_IDS).withDefault('flags'),
  );

  const pathname = usePathname() ?? '';
  const chromeless = isChromelessPath(pathname);

  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the drag-resized width from localStorage post-mount.
  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Reserve right-side layout space (or release it on chromeless routes) so the
  // app shifts left and the rail docks rather than floating over content.
  useEffect(() => {
    if (!hydrated) return;
    if (chromeless) {
      document.body.classList.remove('has-dev-rail');
      document.body.classList.remove('dev-rail-collapsed');
      document.documentElement.style.removeProperty('--dev-rail-w');
      return;
    }
    const offsetWidth = open ? width : COLLAPSED_WIDTH;
    document.documentElement.style.setProperty('--dev-rail-w', `${offsetWidth}px`);
    document.body.classList.add('has-dev-rail');
    document.body.classList.toggle('dev-rail-collapsed', !open);
    try {
      window.localStorage.setItem(wsLocalKey(WIDTH_STORAGE_KEY), String(width));
    } catch { /* sandbox / quota */ }
  }, [open, width, hydrated, chromeless]);

  // Keep the width within the viewport ceiling as the window resizes.
  useEffect(() => {
    if (!hydrated) return;
    const onResize = () => setWidth((current) => clampWidth(current, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hydrated]);

  // Strip the reservation on unmount (HMR / route teardown safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-dev-rail');
        document.body.classList.remove('dev-rail-collapsed');
        document.documentElement.style.removeProperty('--dev-rail-w');
      } catch { /* DOM may be torn down already */ }
    };
  }, []);

  // Drag-to-resize from the LEFT edge: the rail hugs the right viewport edge, so
  // its width is the distance from the right edge (innerWidth - clientX).
  const draggingRef = useRef(false);
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    setWidth(clampWidth(window.innerWidth - e.clientX, window.innerWidth));
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  // Chromeless (iframe-target) routes render no chrome — the rail is absent there.
  if (chromeless) return null;

  const renderedWidth = open ? (hydrated ? width : DEFAULT_WIDTH) : COLLAPSED_WIDTH;

  return (
    <>
      <style>{RAIL_CSS}</style>
      <aside
        className="pcdar"
        data-testid="dev-admin-rail"
        data-collapsed={open ? 'false' : 'true'}
        style={{ width: renderedWidth }}
        aria-label="Dev admin rail"
      >
        {/* Collapsed affordance — a thin full-height rail that re-expands. */}
        <button
          type="button"
          className="pcdar__expand-rail"
          data-testid="dev-admin-rail-handle"
          onClick={() => setOpen(true)}
          aria-hidden={open}
          aria-label="Open dev admin rail"
        >
          <span className="pcdar__expand-orb" aria-hidden="true">
            <FlaskConical size={18} />
          </span>
          <span className="pcdar__expand-label">Dev</span>
          <ChevronLeft className="pcdar__expand-chevron" aria-hidden="true" />
        </button>

        <div className="pcdar__expanded-shell" aria-hidden={!open}>
          {open && (
            <>
              <div className="pcdar__header">
                <span className="pcdar__title">
                  <FlaskConical size={14} aria-hidden="true" />
                  Dev admin
                  <span className="pcdar__title-badge">DEV</span>
                </span>
                <span className="pcdar__spacer" />
                <button
                  type="button"
                  className="pcdar__iconbtn"
                  onClick={() => setOpen(false)}
                  aria-label="Close dev admin rail"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>

              <div className="pcdar__acc">
                {SECTIONS.map((s) => {
                  const isActive = s.id === section;
                  const Icon = s.icon;
                  return (
                    <div key={s.id} className={`pcdar__sec${isActive ? ' is-active' : ''}`}>
                      <button
                        type="button"
                        className="pcdar__sec-head"
                        data-testid={`dev-rail-sec-${s.id}`}
                        aria-expanded={isActive}
                        onClick={() => setSection(s.id)}
                      >
                        <span className="pcdar__sec-icon">
                          <Icon size={15} aria-hidden="true" />
                        </span>
                        <span className="pcdar__sec-label">{s.id === 'fleet' ? `${t('fleet')} / coord` : s.label}</span>
                        <span className="pcdar__sec-chevron">
                          <ChevronRight size={15} aria-hidden="true" />
                        </span>
                      </button>
                      {isActive && (
                        <div className="pcdar__sec-body">
                          <Suspense fallback={<div className="pcdar-panel__empty">Loading…</div>}>
                            {s.render(true)}
                          </Suspense>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Drag-to-resize the open panel (hidden while collapsed via CSS). */}
        <div
          className="pcdar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize dev admin rail"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
      </aside>
    </>
  );
}
