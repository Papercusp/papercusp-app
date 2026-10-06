'use client';

/**
 * Quick Panel — the global-shortcut popup's tabbed body
 * (quick-panel-saved-prompts-2026-07-13 P-005).
 *
 * The desktop's global hotkey opens a small always-on-top window
 * (papercusp-desktop/src-tauri/src/docs_search.rs) that loads THIS route.
 * Three tabs:
 *   - Prompts (DEFAULT) — the Workflowy-style saved-prompts outline
 *     (PromptsTab.tsx), backed by harness_shared.saved_prompts.
 *   - Docs — the packaged filesystem search page, embedded same-origin
 *     (/internal/docs/search-palette.html) so the previous behavior of the
 *     popup survives verbatim as one tab.
 *   - Brainstorm — the existing BrainstormFull surface (write/map/canvas +
 *     the BrainstormChat partner) for a picked harness.
 *
 * Shared-component layering: lives under apps/operator/app/ so both the
 * operator tree and the Vite SPA (route apps/operator-vite/src/routes/
 * quick-panel.tsx) can consume it. Tab + brainstorm-harness state are
 * URL-backed (nuqs) per the repo rule — deep-linkable and agent-drivable
 * via ui:dispatch.
 */
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { BookOpenText, Lightbulb, ListTree } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { FLAGS } from '@papercusp/flags';
import { lazyWithRetry } from '@papercusp/operator-core/lib/lazy-with-retry';
import {
  isQuickPanelWindow,
  bindQuickPanelEscape,
  openRouteInApp,
  resolveQuickPanelHandoff,
} from '@papercusp/operator-core/lib/client-navigation';
import { useFlag } from '@/lib/flag-hooks';
import { Select } from '@/app/harness/Select';
import { OperatorChatSidebar } from '@/app/_components/OperatorChatSidebar';
import PromptsTab from './PromptsTab';
import './quick-panel.css';

const BrainstormFull = lazyWithRetry(() =>
  import('@/app/harness/brainstorm/BrainstormFull').then((m) => ({ default: m.BrainstormFull })),
);

// UI order (owner ask 2026-07-14: Brainstorm second): Prompts · Brainstorm · Docs.
const QP_TABS = ['prompts', 'brainstorm', 'docs'] as const;
type QpTab = (typeof QP_TABS)[number];

/** The lite registry row the harness picker needs (subset of harnessProjects.lite). */
type HarnessLite = { slug: string; title?: string | null; name?: string | null };

const BS_HARNESS_LS_KEY = 'pc-qp-brainstorm-harness';

function BrainstormPane({ queryPrefix }: { queryPrefix: string }) {
  const { data } = useSyncQuery<HarnessLite>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const harnesses = useMemo(() => data ?? [], [data]);
  const [slug, setSlug] = useQueryState(`${queryPrefix}bs`, parseAsString.withDefault(''));

  // Remember the last-used harness across window reopens (the popup window
  // always loads the bare /quick-panel URL).
  useEffect(() => {
    if (slug) {
      try {
        window.localStorage.setItem(BS_HARNESS_LS_KEY, slug);
      } catch {
        /* private-mode etc. — remembering is best-effort */
      }
    }
  }, [slug]);
  useEffect(() => {
    if (slug || harnesses.length === 0) return;
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(BS_HARNESS_LS_KEY);
    } catch {
      remembered = null;
    }
    const fallback =
      (remembered && harnesses.some((h) => h.slug === remembered) ? remembered : null) ??
      harnesses[0]?.slug ??
      null;
    if (fallback) void setSlug(fallback);
  }, [slug, harnesses, setSlug]);

  if (harnesses.length === 0) {
    return <div className="pc-qp__empty">No harnesses registered yet — create one from the dashboard first.</div>;
  }
  return (
    <div className="pc-qp__brainstorm">
      <div className="pc-qp__bsbar">
        <span className="pc-qp__bslabel">harness</span>
        <Select
          value={slug}
          onChange={(v) => void setSlug(v)}
          options={harnesses.map((h) => ({ value: h.slug, label: h.title || h.name || h.slug }))}
          ariaLabel="Brainstorm harness"
        />
      </div>
      <div className="pc-qp__bsbody">
        {slug ? (
          <Suspense fallback={<div className="pc-qp__empty">Loading brainstorm…</div>}>
            <BrainstormFull slug={slug} />
          </Suspense>
        ) : (
          <div className="pc-qp__empty">Pick a harness to brainstorm in.</div>
        )}
      </div>
    </div>
  );
}

/**
 * @param headerSlot Optional status strip rendered above the tabs. The Vite SPA
 *   route (apps/operator-vite/src/routes/quick-panel.tsx) injects the shared
 *   AdvShell "N POT running" + "N agents running" pills here — those components
 *   live under operator-vite/src and cannot be imported up-layer from this
 *   operator/app page, so the route composes them and passes them down
 *   (quick-panel-status-pills-2026-07-13 D-001).
 * @param chatSidebar Whether to mount the docked OperatorChatSidebar (default
 *   true, behind OPERATOR_CHAT_SIDEBAR). A host that already has its own chat
 *   dock beside this page — the cloud portal mounts it as a shell panel
 *   (portal-quick-panel-palette-2026-09-06 D-001) — passes false: the sidebar
 *   writes `--op-chat-w` on :root and `body.has-op-chat`, which would shift
 *   that host's whole page for a rail it never asked for.
 * @param queryPrefix Prefix for this page's nuqs keys (`tab`, `bs`, and the
 *   prompts tab's `q` / `sel` / `zoom` / `done`). Empty in the popup window,
 *   which owns its URL. A host that mounts the page OVER another page shares
 *   that page's URL, and the bare keys collide there: the portal shell's search
 *   box is `q`, and its dev / cloud pages own `tab` — switching the palette to
 *   Brainstorm would reset the dev console's tab underneath it.
 */
export default function QuickPanelPage({
  headerSlot,
  chatSidebar: chatSidebarWanted = true,
  queryPrefix = '',
}: { headerSlot?: ReactNode; chatSidebar?: boolean; queryPrefix?: string } = {}) {
  const enabled = useFlag(FLAGS.QUICK_PANEL);
  // The Papercup chat / 🫖 Pot Health sidebar, docked left inside the panel
  // window (owner ask 2026-07-14). /quick-panel is chromeless, so ChromeShell —
  // the sidebar's usual host — never renders here; the page mounts it itself,
  // behind the same flag. It sets --op-chat-w on :root, which .pc-qp consumes
  // as left padding, exactly like the main app's body offset.
  const chatSidebarFlag = useFlag(FLAGS.OPERATOR_CHAT_SIDEBAR);
  const chatSidebar = chatSidebarWanted && chatSidebarFlag;
  const [tab, setTab] = useQueryState(
    `${queryPrefix}tab`,
    parseAsStringEnum<QpTab>([...QP_TABS]).withDefault('prompts'),
  );
  // Radix mounts an inactive pane after the tab transition. A ref alone can be
  // null when the tab effect runs, so bind when the actual frame is committed.
  const [docsFrame, setDocsFrame] = useState<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!enabled || !isQuickPanelWindow()) return;
    return bindQuickPanelEscape(document, docsFrame, () => {
      // Rust intercepts CloseRequested and hides this reusable palette window.
      // Invoke from the parent: navigated iframe docs do not carry Tauri's API.
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch((error) => console.warn('[quick-panel] could not dismiss window', error));
    });
  }, [enabled, docsFrame]);

  // WI-4827: the Quick Panel window is chromeless by ROUTE only — a control that
  // links into the full app (the chat sidebar's mic-settings gear → /settings/voice,
  // the account menu → /settings/user, a TanStack <Link>, …) would navigate this
  // small popup in place and render the whole operator app inside it. Capture link
  // clicks that would LEAVE the chromeless sandbox and hand them to the desktop,
  // which opens them in the main app window (Spotlight-style) and hides the panel.
  // navigateClient's own guard covers programmatic navigations; this covers anchors.
  useEffect(() => {
    if (!isQuickPanelWindow()) return;
    const onClick = (e: MouseEvent) => {
      // Respect modified / non-primary clicks (open-in-new-window etc.) and
      // already-handled events.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const handoff = resolveQuickPanelHandoff(href, window.location.href, {
        isQuickPanelWindow: true,
      });
      if (!handoff) return;
      // Fully own the click: preventDefault stops the browser navigation, and
      // stopPropagation stops the anchor's own React onClick (e.g. a
      // navigateClient handler) from double-firing the hand-off.
      e.preventDefault();
      e.stopPropagation();
      openRouteInApp(handoff);
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  if (!enabled) {
    return (
      <div className="pc-qp pc-qp--disabled">
        <div className="pc-qp__empty">
          The Quick Panel is disabled (flag <code>papercusp-quick-panel</code>) — flip it on at{' '}
          <code>/admin/features</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="pc-qp">
      {chatSidebar && <OperatorChatSidebar />}
      {headerSlot ? <div className="pc-qp__statusbar">{headerSlot}</div> : null}
      <Tabs.Root
        className="pc-qp__root"
        value={tab}
        onValueChange={(v) => void setTab(v as QpTab)}
      >
        <Tabs.List className="pc-qp__tabs" aria-label="Quick Panel tabs">
          <Tabs.Trigger className="pc-qp__tab" value="prompts">
            <ListTree size={13} aria-hidden />
            Prompts
          </Tabs.Trigger>
          <Tabs.Trigger className="pc-qp__tab" value="brainstorm">
            <Lightbulb size={13} aria-hidden />
            Brainstorm
          </Tabs.Trigger>
          <Tabs.Trigger className="pc-qp__tab" value="docs">
            <BookOpenText size={13} aria-hidden />
            Docs
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content className="pc-qp__pane" value="prompts">
          <PromptsTab queryPrefix={queryPrefix} />
        </Tabs.Content>

        <Tabs.Content className="pc-qp__pane" value="brainstorm">
          <BrainstormPane queryPrefix={queryPrefix} />
        </Tabs.Content>

        <Tabs.Content className="pc-qp__pane" value="docs">
          {/* Package-local docs search and result navigation remain same-origin. */}
          <iframe
            ref={setDocsFrame}
            className="pc-qp__docsframe"
            src="/internal/docs/search-palette.html"
            title="Docs search"
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
