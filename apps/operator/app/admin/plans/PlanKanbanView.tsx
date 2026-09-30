'use client';

/**
 * PlanKanbanView — the Create-tab plan board (P-025). Presentation rides the
 * vendored Kibo UI kanban primitives (`@/app/harness/Kanban` — provenance and
 * upstream deviations in that file's header); this file owns only the plan
 * data layer and the card/header content.
 *
 * Data: items come LIVE from `useSyncQuery('planItems.byPlan')` — the resolver
 * re-parses the plan's markdown content on every read (NOT the
 * `harness_plans.items` jsonb column, which is only re-projected on a plan
 * WRITE and so was stale/empty for plans untouched since it landed). A drag
 * writes through `useSyncMutate('plans.setStatus', setItemStatus)`, and the
 * set-status route fires `notifySyncInvalidate('planItems.byPlan')`, so the
 * board re-pulls and moves even when ANOTHER agent flips a status. The `items`
 * prop is the `plans:get` snapshot PlanDetail already holds; the board renders
 * it whenever the live query has no rows yet (first pull pending, error, or no
 * SyncProvider) so it ALWAYS shows data when the plan has any.
 *
 * Bucketing is by the STORED status token (the jsonb `status`); the columns are
 * the stored tokens, so the issue-block `effectiveStatus` overlay (a derived
 * read-time concept) isn't needed here.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
  type DragEndEvent,
} from '@/app/harness/Kanban';
import { setItemStatus, type PlanItem, type ItemStatus } from './plans-api';
import './plan-kanban.css';

// One column per plan-item status — the SAME six tokens `ItemStatus` /
// plans:set-status use, so the board is 1:1 with the statuses in the plan
// markdown. Any item whose status somehow isn't one of these still gets its own
// trailing column (see `columns` below), so an item is never silently hidden.
const KANBAN_COLS: Array<{ status: ItemStatus; label: string; accent: string }> = [
  { status: 'todo', label: 'To Do', accent: 'var(--fg-mute)' },
  { status: 'wip', label: 'In Progress', accent: 'var(--accent)' },
  { status: 'blocked', label: 'Blocked', accent: 'var(--bad, #f87171)' },
  { status: 'needs-human', label: 'Needs Human', accent: 'var(--warn)' },
  { status: 'done', label: 'Done', accent: 'var(--good)' },
  { status: 'dropped', label: 'Dropped', accent: 'color-mix(in oklab, var(--fg-mute), transparent 30%)' },
];
const COL_STATUSES = KANBAN_COLS.map((c) => c.status);
const isColStatus = (s: string): s is ItemStatus => (COL_STATUSES as string[]).includes(s);

/** Normalized shape the board renders. plans:get items carry `storedStatus`
 *  (the exact token in the plan markdown — what a drag flips); raw jsonb rows
 *  carry `status`. Bucket by the STORED token so the column mirrors the plan. */
interface BoardItem {
  id: string;
  text: string;
  status: string;
}

function normalize(raw: unknown): BoardItem | null {
  const it = raw as { id?: string; text?: string; status?: string; storedStatus?: string };
  if (!it || typeof it.id !== 'string') return null;
  const status = it.storedStatus ?? it.status ?? 'todo';
  return { id: it.id, text: typeof it.text === 'string' ? it.text : '', status };
}

/** Kibo item shape: `name` is the card text, `column` the status token. */
type KItem = { id: string; name: string; column: string };
const toKItem = (it: BoardItem): KItem => ({ id: it.id, name: it.text, column: it.status });

export interface PlanKanbanViewProps {
  /** Plan slug — the sync-query key and the set-status target. */
  slug: string;
  /** plans:get snapshot — initial render + no-SyncProvider fallback. */
  items: PlanItem[];
  /** Optional nudge so the rest of the detail (badges/counts) refreshes too. */
  onChanged?: () => void;
}

export default function PlanKanbanView({ slug, items, onChanged }: PlanKanbanViewProps) {
  // Live items from `planItems.byPlan`. The @papercusp/sync hook returns a
  // (frozen) EMPTY ARRAY — never `undefined` — while the first pull is pending
  // or after an error, so the snapshot fallback MUST key off "no rows yet", not
  // `data !== undefined` (which never fires under a live provider and left the
  // board blank until the live pull landed). A genuinely item-less plan has an
  // empty snapshot too, so the floor stays correct there as well.
  const { data } = useSyncQuery<unknown>({ queryName: 'planItems.byPlan', args: { planSlug: slug } });
  const live = Array.isArray(data) ? (data as unknown[]) : [];
  const source = live.length > 0 ? live : (items as unknown[]);

  const server = useMemo(
    () => (Array.isArray(source) ? source.map(normalize).filter((x): x is BoardItem => x !== null) : []),
    [source],
  );

  // Optimistic status overrides — applied instantly on drop, cleared once the
  // live data agrees (the set-status invalidate round-trips back here).
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const statusSig = server.map((i) => `${i.id}:${i.status}`).join('|');
  useEffect(() => {
    setOptimistic((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const i of server) {
        if (next[i.id] === i.status) {
          delete next[i.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // server identity changes each render; key off the stable status signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSig]);

  const view = useMemo(
    () => server.map((it) => (optimistic[it.id] ? { ...it, status: optimistic[it.id]! } : it)),
    [server, optimistic],
  );

  // The board state the drag mutates live (KanbanProvider flips an item's
  // column while it hovers). Re-derived from `view` whenever a status changes
  // server-side or optimistically; diverges only mid-drag.
  const [board, setBoard] = useState<KItem[]>(() => view.map(toKItem));
  const boardRef = useRef(board);
  boardRef.current = board;
  const viewSig = view.map((i) => `${i.id}:${i.status}`).join('|');
  useEffect(() => {
    setBoard(view.map(toKItem));
    // view identity changes each render; key off the stable status signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSig]);

  // The six known columns, then a trailing column for any unexpected status
  // present in the data — so EVERY plan item lands in exactly one column and
  // none is ever silently hidden.
  const columns = useMemo(() => {
    const extra = [...new Set(view.map((i) => i.status))].filter((s) => !isColStatus(s));
    return [
      ...KANBAN_COLS.map((c) => ({ id: c.status as string, name: c.label, accent: c.accent })),
      ...extra.map((s) => ({ id: s, name: s, accent: 'var(--fg-mute)' })),
    ];
  }, [view]);

  const countByColumn = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of columns) m.set(c.id, 0);
    for (const it of board) m.set(it.column, (m.get(it.column) ?? 0) + 1);
    return m;
  }, [board, columns]);

  const setStatusSync = useSyncMutate('plans.setStatus', setItemStatus);

  const move = async (id: string, to: string) => {
    const cur = view.find((i) => i.id === id);
    if (!cur || cur.status === to) return;
    setOptimistic((o) => ({ ...o, [id]: to }));
    try {
      await setStatusSync({ slug, itemId: id, status: to as ItemStatus });
      onChanged?.();
    } catch {
      setOptimistic((o) => {
        const n = { ...o };
        delete n[id];
        return n;
      });
    }
  };

  const resetBoard = () => setBoard(view.map(toKItem));

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) {
      resetBoard();
      return;
    }
    // The provider already flipped the active item's column in `board` during
    // dragOver; read the landing column from there and persist the diff.
    const landed = boardRef.current.find((i) => i.id === String(active.id));
    const from = view.find((i) => i.id === String(active.id))?.status;
    if (landed && from && landed.column !== from) {
      void move(landed.id, landed.column);
    } else {
      resetBoard();
    }
  }

  return (
    <KanbanProvider<KItem, { id: string; name: string; accent: string }>
      columns={columns}
      data={board}
      onDataChange={setBoard}
      onDragEnd={onDragEnd}
      onDragCancel={resetBoard}
      overlay={(item) => <PlanCardBody id={item.id} text={item.name} />}
      className="pk-plan-kanban"
    >
      {(col) => (
        <KanbanBoard id={col.id} key={col.id}>
          <KanbanHeader>
            <span className="pk-kanban__dot" style={{ background: col.accent }} />
            {col.name}{' '}
            <span className="pk-plan-kanban__count">({countByColumn.get(col.id) ?? 0})</span>
          </KanbanHeader>
          <KanbanCards id={col.id}>
            {(item) => (
              <KanbanCard
                key={item.id}
                id={item.id}
                name={item.name}
                column={item.column}
                className={optimistic[item.id] ? 'is-saving' : undefined}
              >
                <PlanCardBody id={item.id} text={item.name} />
              </KanbanCard>
            )}
          </KanbanCards>
        </KanbanBoard>
      )}
    </KanbanProvider>
  );
}

/** The card's content — P-id eyebrow + a stripped, capped text preview.
 *  Shared by the in-column card and the DragOverlay copy. */
function PlanCardBody({ id, text }: { id: string; text: string }) {
  return (
    <>
      <code className="pk-plan-kanban__id">{id}</code>
      <span className="pk-plan-kanban__text">{text.replace(/^`[^`]+`\s*/, '').slice(0, 120)}</span>
    </>
  );
}
