'use client';

/**
 * AdvChatPanel — a dockview panel slot that hosts an in-app agent chat.
 *
 * Reuses the standalone <ChatPanel> (the same one the retired /pi dock
 * mounted). A panel is a reusable "slot": when its params carry a
 * `chatId` it renders that chat; when empty it shows a work-item picker
 * (WI-125: openable from the Add-panel catalog, so a chat can start
 * without going through Detail) and is a "free slot" the open-chat
 * drain (HarnessesDock) fills first. Archiving a chat clears the slot
 * back to free rather than closing the panel, so it can host the next
 * chat.
 */

import { useCallback, useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { openFeatureChat } from '@papercusp/papercusp-shared';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import ChatPanel from '../../harness/ChatPanel';
import { Select } from '../../harness/Select';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

// Terminal states excluded from the picker — steering targets in-flight work.
// Kept as a client-side backstop; `PICKER_FETCH_STATES` below is what actually
// bounds the fetch. NB 'dropped'/'passed' are terminal too and were missing here,
// so before the states fetch this set let dropped work into the picker.
const TERMINAL_STATES = new Set([
  'done',
  'closed',
  'resolved',
  'archived',
  'deprecated',
  'dropped',
  'passed',
]);

/**
 * The NON-terminal statuses the picker fetches, one bounded slice each.
 *
 * WI-6124. This used to send no `limit` at all, deliberately: the picker wants a
 * multi-state predicate ("not done/closed/…") that a single server-side `state`
 * filter could not express, so it took the resolver's full 2000-row cap and
 * filtered client-side. That reasoning is now obsolete — `workItems.byHarness`
 * grew a `states` arg (hud-open-destinations-2026-07-27 P-004) that expresses
 * exactly this predicate server-side.
 *
 * Taking the full cap was costing twice over:
 *  - WRONG SAMPLE (the reason this change was made). The 2000-row window is
 *    ordered `updated_ts DESC` across ALL statuses, so recently-touched terminal
 *    work crowds out the in-flight items the picker exists to show. Measured on
 *    `papercusp` 2026-08-02: the window held 1,605 of the harness's 14,475
 *    non-terminal items — 11%, not the "WHOLE non-terminal set" the old comment
 *    claimed. `states` fetches up to `perState` rows for EACH status, so every
 *    one is actually represented.
 *  - OVER-FETCH. Those are fully-enriched rows (body + payload JSONB) for a
 *    dropdown that renders {id, title, state}, re-resolved on every sync
 *    invalidation. ⚠ Do NOT cite this as a measured hot spot: this statement has
 *    a large LIFETIME total in pg_stat_statements but did NOT appear in a 562s
 *    in-window sample on 2026-08-02, i.e. it is mostly historical. The fix stands
 *    on the sampling bug above; the row reduction (600 vs 2000) is a bonus, not a
 *    measured win.
 *
 * Rollout-skew safety is preserved: an older deployed resolver that predates
 * `states` strips the unknown key (the schema is non-strict) and falls back to
 * its default window — i.e. exactly today's behaviour, never an error.
 */
const PICKER_FETCH_STATES = ['needs-human', 'wip', 'in-progress', 'blocked', 'open', 'todo'];
/** Per-status slice. 6 statuses x 100 caps the fetch at 600 rows (vs 2000) while
 *  giving each status far more headroom than a dropdown can usefully show. */
const PICKER_PER_STATE = 100;

/** The free-slot empty state: pick a work item, start a worker chat on it.
 *  Same `openFeatureChat` defaults as the Detail-pane Chat button (EI-290):
 *  role worker, mode discuss. The drain then fills this (first free) slot. */
function StartChatPicker({ slug }: { slug: string }) {
  const [featureId, setFeatureId] = useState('');
  const [starting, setStarting] = useState(false);
  const query = useSyncQuery<{ id: string; title: string; state: string }>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug: slug, states: PICKER_FETCH_STATES, perState: PICKER_PER_STATE },
    enabled: Boolean(slug),
  });
  const items = useMemo(
    () => (query.data ?? []).filter((i) => !TERMINAL_STATES.has(i.state)),
    [query.data],
  );
  const start = useCallback(async () => {
    const item = items.find((i) => i.id === featureId);
    if (!item) return;
    setStarting(true);
    try {
      const res = await openFeatureChat({
        slug,
        role: 'worker',
        featureId: item.id,
        title: item.title,
        mode: 'discuss',
      });
      if (res && typeof res === 'object' && 'error' in res) {
        throw new Error(String((res as { error: unknown }).error));
      }
    } catch (e) {
      toast.error('Open chat failed', { description: String(e) });
    } finally {
      setStarting(false);
    }
  }, [featureId, items, slug]);

  return (
    <div
      className="pc-adv-chat-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        height: '100%',
        padding: '16px',
        textAlign: 'center',
        color: 'var(--fg-dim)',
        fontSize: '13px',
        lineHeight: 1.5,
      }}
    >
      <MessageCircle size={18} aria-hidden />
      <span>
        Start a chat with the worker about a work item — or use the Chat button on a
        work item&apos;s Detail pane.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: '100%' }}>
        <Select
          ariaLabel="Work item to chat about"
          testId="adv-chat-pick"
          value={featureId}
          onChange={setFeatureId}
          disabled={query.loading || items.length === 0}
          placeholder={query.loading ? 'Loading work items…' : items.length === 0 ? 'No open work items' : 'Choose a work item…'}
          triggerStyle={{ maxWidth: 260, fontSize: 12, padding: '4px 6px' }}
          options={items.map((i) => ({ value: i.id, label: `${i.id} · ${i.title}` }))}
        />
        <button
          type="button"
          data-testid="adv-chat-start"
          disabled={!featureId || starting}
          onClick={() => void start()}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          {starting ? 'Starting…' : 'Start chat'}
        </button>
      </div>
    </div>
  );
}

export default function AdvChatPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const chatId = (params.chatId as string) || '';
  const mode = params.mode === 'discuss' ? 'discuss' : undefined;

  const onArchive = useCallback(() => {
    // Free the slot (keep the panel) so the next opened chat reuses it.
    api.setParams({ ...params, chatId: null });
    api.setTitle('Chat');
  }, [api, params]);

  if (!chatId) {
    return <StartChatPicker slug={slug} />;
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} mode={mode} onArchive={onArchive} />
    </div>
  );
}
