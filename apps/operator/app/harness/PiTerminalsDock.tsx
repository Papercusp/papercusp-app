'use client';

/**
 * PiTerminalsDock — multi-pane container for pi/omp terminals.
 *
 * Wraps `dockview-react` so the operator can open multiple terminals as
 * tabs, drag them into splits, and rearrange. Each panel mounts its own
 * `<PiPanel>` instance, which independently spawns a pty, owns its xterm
 * instance, and tears everything down on unmount.
 *
 * Layout is persisted in localStorage per harness slug. On reload, the
 * previous arrangement is restored; pty contents are NOT restored (each
 * pane spawns a fresh pty).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import { Plus, TerminalSquare } from "lucide-react";
import PiPanel from './PiPanel';
import ChatPanel from './ChatPanel';
import { Tooltip } from './Tooltip';
import { fetchSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface PiTerminalsDockProps {
  slug: string;
  /** Optional initial laneId for the first terminal — typically the active feature. */
  initialLaneId?: string;
}

interface TerminalPanelParams {
  slug: string;
  laneId?: string;
}

interface ChatPanelParams {
  slug: string;
  chatId: string;
}

const LAYOUT_STORAGE_PREFIX = 'papercusp:pi-dock-layout:';

function layoutKey(slug: string): string {
  return wsLocalKey(`${LAYOUT_STORAGE_PREFIX}${slug}`);
}

/**
 * Module-level dedup guard for /pty/prewarm fetches.
 *
 * React rule: parent useEffects run AFTER child useEffects. If we only
 * fired prewarm from PiTerminalsDock's useEffect, PiPanel's /pty/spawn
 * POST would already be on the wire by the time prewarm fires — server
 * sees /spawn first and cold-forks omp every time, even with the
 * synchronous slot reservation in pty.ts. Firing during render (with a
 * dedup guard so React StrictMode and re-renders don't multi-fire) gets
 * prewarm to the server BEFORE the dock children mount.
 *
 * Guard expires just under PREWARM_TTL_MS so a long-lived dock that
 * exhausts the warm pool eventually re-warms instead of going cold.
 */
const FIRED_PREWARMS = new Set<string>();
const PREWARM_GUARD_MS = 55_000;

function firePrewarmOnce(slug: string, laneId: string | undefined): void {
  if (typeof window === 'undefined' || !slug) return;
  const k = `${slug}|${laneId ?? ''}`;
  if (FIRED_PREWARMS.has(k)) return;
  FIRED_PREWARMS.add(k);
  setTimeout(() => FIRED_PREWARMS.delete(k), PREWARM_GUARD_MS);
  fetch(`/api/harness/${encodeURIComponent(slug)}/pty/prewarm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(laneId ? { laneId } : {}),
  }).catch(() => {
    // Failure is fine — guard expires after PREWARM_GUARD_MS, and
    // /pty/spawn falls through to a cold fork anyway.
    FIRED_PREWARMS.delete(k);
  });
}

/**
 * Cross-component event for opening a chat panel from elsewhere in the
 * dashboard (e.g., FeaturePeekPanel's "chat" button). Dispatched on
 * window; the dock listens. Detail = the chat metadata to mount.
 *
 * Race fix: the event is fired by `openFeatureChat()` *before* the
 * caller switches the dashboard to the consoles tab — so when the
 * dispatcher fires, the dock hasn't mounted yet and no listener exists.
 * To handle that, every dispatch ALSO pushes the detail onto the
 * module-level `pendingOpens` queue. When the dock mounts (or when its
 * event listener fires), it drains the queue. Either path opens the
 * panel exactly once; the queue entry is removed as part of opening.
 */
export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

const pendingOpens: OpenChatEventDetail[] = [];

function drainPendingOpens(api: DockviewApi, slug: string): void {
  for (let i = pendingOpens.length - 1; i >= 0; i--) {
    const detail = pendingOpens[i];
    if (detail.slug !== slug) continue;
    const panelId = `chat-${detail.chatId}`;
    const existing = api.panels.find((p) => p.id === panelId);
    if (existing) {
      try { existing.api.setActive(); } catch { /* ignore */ }
    } else {
      // Add into the currently-active group so the new chat appears as
      // a tab next to whatever the user was looking at, not as a fresh
      // split. Without this, dockview defaults to creating a new group
      // when the layout is non-empty and the active group's reference
      // becomes ambiguous (StrictMode double-mount can do this).
      const activeGroup = api.activeGroup;
      const panel = api.addPanel({
        id: panelId,
        component: 'chat',
        title:
          detail.title ??
          (detail.featureId
            ? `${detail.role ?? 'agent'} · ${detail.featureId}`
            : (detail.role ?? 'chat')),
        params: { slug: detail.slug, chatId: detail.chatId } satisfies ChatPanelParams,
        ...(activeGroup ? { position: { referenceGroup: activeGroup } } : {}),
      });
      // addPanel restores the previously-active panel from saved layout
      // by default — explicitly activate the new one so the user sees
      // their just-opened chat instead of a stale layout-restored panel.
      try { panel.api.setActive(); } catch { /* ignore */ }
    }
    pendingOpens.splice(i, 1);
  }
}

/**
 * Validate any restored chat panels against the live chat list. Any chat
 * panel whose chat row no longer exists (deleted or archived) gets closed
 * so the operator doesn't see ghost panels from past sessions.
 *
 * Async + best-effort: if the fetch fails, leave the layout alone.
 */
async function pruneStaleChatPanels(api: DockviewApi, slug: string, workspaceId: string): Promise<void> {
  const chatPanelIds = api.panels
    .map((p) => p.id)
    .filter((id) => id.startsWith('chat-'));
  if (chatPanelIds.length === 0) return;

  let liveChatIds: Set<string>;
  try {
    const rows = await fetchSyncQuery<{ id: string }>({
      queryName: 'agentChats.byHarness',
      args: { harnessSlug: slug, workspaceId, limit: 500 },
      staleTime: 30_000,
    });
    liveChatIds = new Set(rows.map((c) => c.id));
  } catch {
    return;
  }

  for (const panelId of chatPanelIds) {
    const chatId = panelId.slice('chat-'.length);
    if (!liveChatIds.has(chatId)) {
      const panel = api.getPanel(panelId);
      if (panel) {
        try { api.removePanel(panel); } catch { /* ignore */ }
      }
    }
  }
}

/** Component rendered inside each dockview panel. */
function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { slug, laneId } = props.params;
  // props.api.id is the dockview panel id (term-initial, term-<rand>, …)
  // and is stable across React unmount/remount, which is exactly what we
  // need for sessionStorage-keyed pty resume. Without this every panel
  // would key under 'default' and two terminals would clobber each
  // other's stored id.
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <PiPanel slug={slug} laneId={laneId} panelId={props.api.id} />
    </div>
  );
}

/** Component for chat panels in the dock. */
function ChatPanelComponent(props: IDockviewPanelProps<ChatPanelParams>) {
  const { slug, chatId } = props.params;
  const onArchive = useCallback(() => {
    // The dock keeps a reference to its api via closure on `props.api` —
    // remove this panel.
    props.api.close();
  }, [props.api]);
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} onArchive={onArchive} />
    </div>
  );
}

/** Header action: "+" to add another terminal as a new tab. */
function AddTerminalAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  // Pre-warm the no-laneId pool while the user is hovering / focusing the
  // button — by the time the click fires, omp has already forked and the
  // /pty/spawn POST adopts it instead of cold-forking. The dedup guard
  // makes hover-spam free.
  const onPointerEnter = useCallback(() => firePrewarmOnce(slug, undefined), [slug]);
  const onClick = useCallback(() => {
    if (!api) return;
    // Belt-and-braces: also fire on click in case the user tabbed in via
    // keyboard and skipped pointerenter.
    firePrewarmOnce(slug, undefined);
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = api.panels.filter((p) => p.id.startsWith('term-')).length;
    api.addPanel({
      id,
      component: 'terminal',
      title: `terminal ${existing + 1}`,
      params: { slug } satisfies TerminalPanelParams,
    });
  }, [api, slug]);

  return (
    <Tooltip label="Open another terminal">
      <button
        type="button"
        onClick={onClick}
        onPointerEnter={onPointerEnter}
        onFocus={onPointerEnter}
        className="pi-dock__add-btn"
      >
        <Plus size={13} />
        <span>terminal</span>
      </button>
    </Tooltip>
  );
}


export default function PiTerminalsDock({ slug, initialLaneId }: PiTerminalsDockProps) {
  const workspaceId = useWorkspaceId();
  // Fire prewarm DURING render — must run before child PiPanel effects
  // POST /pty/spawn. Both keys: the lane-scoped one for the seed terminal
  // (initialLaneId) and the no-laneId one used by the + button. Dedup'd
  // via FIRED_PREWARMS so re-renders / StrictMode don't spawn extras.
  firePrewarmOnce(slug, initialLaneId);
  if (initialLaneId !== undefined) firePrewarmOnce(slug, undefined);

  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {

      apiRef.current = event.api;
      setApi(event.api);

      // Try to restore a saved layout; on any failure, seed a single terminal.
      let restored = false;
      try {
        const raw = window.localStorage.getItem(layoutKey(slug));
        if (raw) {
          const parsed = JSON.parse(raw);
          event.api.fromJSON(parsed);
          restored = event.api.panels.length > 0;
        }
      } catch {
        restored = false;
      }

      // If the user is opening a chat from the dashboard, don't also
      // seed an initial terminal — they came here for the chat. Only
      // seed when the dock is opened cold (no saved layout, no queued
      // chats waiting).
      const hasPendingForThisSlug = pendingOpens.some((d) => d.slug === slug);
      if (!restored && !hasPendingForThisSlug) {
        event.api.addPanel({
          id: `term-initial`,
          component: 'terminal',
          title: 'terminal 1',
          params: { slug, laneId: initialLaneId } satisfies TerminalPanelParams,
        });
      }

      // Persist layout on every change. CRITICAL: registered BEFORE
      // drainPendingOpens so that any chat panels added by the drain
      // are persisted to localStorage. Otherwise React StrictMode's
      // double-mount in dev silently loses chat panels: round 1 drains
      // the queue and adds the panel but persist isn't wired yet, so
      // localStorage stays stale; round 2 restores from stale storage
      // and finds the queue already drained.
      //
      // Phase 2 of dockview-migration: dual-write to PG. localStorage
      // stays as the fast-path sync cache (preserves zero-flicker reads);
      // PG is the cross-device source of truth. Read prefers localStorage
      // for instant restore, then a background fetch overlays PG state
      // (handles "I rearranged on another machine" without sacrificing
      // first-paint latency).
      const layoutNameForPg = `pi:${slug}`;
      const persist = () => {
        try {
          const body = JSON.stringify(event.api.toJSON());
          window.localStorage.setItem(layoutKey(slug), body);
          // Best-effort PG write. Coalesced via debounce below to avoid
          // hammering on rapid drags.
          schedulePgWrite(body);
        } catch { /* quota / private mode — ignore */ }
      };
      let pgWriteTimer: ReturnType<typeof setTimeout> | null = null;
      let pgWritePending: string | null = null;
      const flushPgWrite = async () => {
        if (!pgWritePending) return;
        const body = pgWritePending;
        pgWritePending = null;
        try {
          // `?ws=` is REQUIRED: the route resolves the workspace from this param,
          // falling back to PAPERCUSP_WORKSPACE_ID ?? 'default' — and that env var
          // is not set on the operator. The matching READ below is scoped by an
          // explicit `workspaceId` arg, so omitting it here writes one workspace's
          // row and reads another's: the PUT returns 2xx and the layout silently
          // never persists (EI-19425275400158684).
          await fetch(`/api/dock-layouts/${encodeURIComponent(layoutNameForPg)}?ws=${encodeURIComponent(workspaceId)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              layout: { schemaVersion: 0, dockviewJson: JSON.parse(body) },
            }),
          });
        } catch { /* operator unreachable — localStorage already saved */ }
      };
      const schedulePgWrite = (body: string) => {
        pgWritePending = body;
        if (pgWriteTimer) clearTimeout(pgWriteTimer);
        pgWriteTimer = setTimeout(flushPgWrite, 800);
      };
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);

      // Background PG overlay: if PG has a NEWER snapshot than the
      // localStorage we restored from, swap to it. Triggered once
      // per mount, after the sync restore + initial seed run.
      void (async () => {
        try {
          const row = (await fetchSyncQuery<{
            layoutJson?: { schemaVersion?: number; dockviewJson?: unknown };
            updatedTs: number;
            createdTs?: number;
          }>({
            queryName: 'dockLayouts.byName',
            args: { workspaceId, name: layoutNameForPg },
            staleTime: 30_000,
          }))[0];
          if (!row) return;
          const body = row?.layoutJson;
          if (
            body &&
            body.schemaVersion === 0 &&
            body.dockviewJson &&
            // Only overlay if PG has been written to (not just seeded).
            // The seed has schemaVersion=1 (LayoutDoc), so this check
            // implicitly skips first-touch reads.
            row.updatedTs > (row.createdTs ?? 0)
          ) {
            // Avoid clobbering an in-flight pending op; check still mounted.
            if (!apiRef.current) return;
            try {
              event.api.fromJSON(body.dockviewJson);
            } catch { /* malformed PG body; localStorage stays authoritative */ }
          }
        } catch { /* operator unreachable; localStorage stays authoritative */ }
      })();

      // Race fix: drain any pending chat opens that arrived before this
      // mount. Without this, clicking "chat" on the dashboard tab silently
      // drops the event because the dock isn't mounted yet — the user sees
      // only the terminal restored from saved layout.
      // Drain any chat-open request stashed by the Oracle dock before
      // navigation. Survives the route change because it lives in
      // sessionStorage, not module memory.
      try {
        const raw = sessionStorage.getItem('oracle_pending_open_chat');
        if (raw) {
          const detail = JSON.parse(raw) as Partial<OpenChatEventDetail> & { slug?: string; chatId?: string };
          if (detail?.slug === slug && detail.chatId) {
            pendingOpens.push({
              slug: detail.slug,
              chatId: detail.chatId,
              role: detail.role,
              title: detail.title,
              featureId: detail.featureId,
            });
          }
          sessionStorage.removeItem('oracle_pending_open_chat');
        }
      } catch { /* ignore */ }

      drainPendingOpens(event.api, slug);

      // Async cleanup: remove chat panels for chats that no longer exist
      // (deleted, archived, expired). Runs after drain so we don't race
      // against new additions. Best-effort — fetches the live chat list
      // and closes panels whose chatId isn't in it.
      void pruneStaleChatPanels(event.api, slug, workspaceId);
    },
    [slug, initialLaneId, workspaceId],
  );

  // Reset stored layout when the harness slug changes (defensive — DockviewReact
  // remounts on key change so this is mostly belt-and-braces).
  useEffect(() => {
    return () => {
      apiRef.current = null;
    };
  }, [slug]);

  // Listen for cross-component "open chat" events. The dispatcher
  // (openFeatureChat) has already created the chat row AND pushed the
  // detail onto pendingOpens. If the dock is mounted, this handler
  // drains the queue immediately. If the dock isn't mounted yet (because
  // the dashboard tab is still active), the event is dropped — but the
  // queue entry remains, and onReady drains it when the dock mounts.
  useEffect(() => {
    const handler = () => {
      const a = apiRef.current;
      if (!a) return;
      drainPendingOpens(a, slug);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, [slug]);

  return (
    <div className="pi-dock">
      <div className="pi-dock__header">
        <span className="pi-dock__title">
          <TerminalSquare size={13} /> consoles
        </span>
        <AddTerminalAction api={api} slug={slug} />
        {/* Agent chat now lives in the floating Oracle dock (tab + picker).
            Use the chat bubble's "+" to start a new agent chat. */}
      </div>
      <div className="pi-dock__body">
        <DockviewReact
          key={slug}
          components={{ terminal: TerminalPanelComponent, chat: ChatPanelComponent }}
          onReady={onReady}
          className="dockview-theme-dark"
        />
      </div>
    </div>
  );
}

/**
 * Helper for callers (FeaturePeekPanel) to create a chat scoped to a
 * feature and open it in the dock. Returns the new chat id so the caller
 * can persist UI state if desired.
 */
export async function openFeatureChat(opts: {
  slug: string;
  role: string;
  featureId: string;
  title?: string;
}): Promise<{ chatId: string } | { error: string }> {
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: opts.role,
        feature_id: opts.featureId,
        title: opts.title,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      return { error: body.error ?? `HTTP ${r.status}` };
    }
    const chat = await r.json();
    const detail: OpenChatEventDetail = {
      slug: opts.slug,
      chatId: chat.id,
      title: chat.title,
      role: chat.role,
      featureId: chat.feature_id ?? undefined,
    };
    // Push to queue first so the dock can drain it on mount even if no
    // listener exists yet (dashboard tab is currently active). The
    // event dispatch handles the case where the dock IS already mounted.
    pendingOpens.push(detail);
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
