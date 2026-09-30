'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from './Tooltip';
import { Select } from './Select';
import { Checkbox } from './Checkbox';
import { openFeatureChat } from './PiTerminalsDock';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, STATUS_ORDER, BOARD_COLUMN_ORDER, HarnessStatus, getStatusMeta } from './theme';
import { StatusPill, IdPill, IconButton, KbdHint } from './primitives';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

const OperatorNoteForm = dynamic(() => import('./OperatorNoteForm'), { ssr: false });
interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: HarnessStatus;
  attempts: number;
  summary?: string;
  labels?: string[];
}

type ViewMode = 'list' | 'board';

interface SavedView {
  id: string;
  name: string;
  filter: {
    statuses?: HarnessStatus[];
    minAttempts?: number;
    search?: string;
  };
}

const BUILT_IN_VIEWS: SavedView[] = [
  { id: 'all', name: 'All', filter: {} },
  { id: 'running', name: 'Running', filter: { statuses: ['in_progress', 'validating'] } },
  { id: 'stuck', name: 'Stuck', filter: { minAttempts: 3 } },
  { id: 'blocked', name: 'Blocked', filter: { statuses: ['blocked', 'failing'] } },
  { id: 'todo', name: 'Todo', filter: { statuses: ['todo'] } },
  { id: 'done', name: 'Passed', filter: { statuses: ['passed'] } },
];

interface Props {
  slug: string;
  features: Feature[];
  activeFeatureId: string | null;
  onSelect: (f: Feature) => void;
  onReset: (id: string) => void;
  onEdit: (f: Feature) => void;
  onOpenInPi?: (id: string) => void;
  onSwitchToPi?: () => void;
  onAdd: () => void;
  onBatchReset: (ids: string[]) => void;
  onBatchDelete: (ids: string[]) => void;
}

export default function FeatureList({
  slug, features, activeFeatureId, onSelect, onReset, onEdit, onOpenInPi, onSwitchToPi, onAdd, onBatchReset, onBatchDelete,
}: Props) {
  const [mode, setMode] = useState<ViewMode>('list');
  const [viewId, setViewId] = useState<string>('all');
  const [search, setSearch] = useState('');
  // Item 7 (2026-04-26): project + tag filters for the new project_id and tags fields
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);

  const view = BUILT_IN_VIEWS.find((v) => v.id === viewId) ?? BUILT_IN_VIEWS[0];

  // Item 7: derive project + tag filter options from current features
  const projectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const f of features) if ((f as any).project_id) set.add((f as any).project_id);
    return Array.from(set).sort();
  }, [features]);

  const filtered = useMemo(() => {
    let out = features;
    if (view.filter.statuses) out = out.filter((f) => view.filter.statuses!.includes(f.status));
    if (view.filter.minAttempts != null) out = out.filter((f) => f.attempts >= view.filter.minAttempts!);
    if (projectFilter !== 'all') {
      out = out.filter((f) => (projectFilter === '__none' ? !(f as any).project_id : (f as any).project_id === projectFilter));
    }
    const tagQ = tagFilter.trim().toLowerCase();
    if (tagQ) {
      out = out.filter((f) => Array.isArray((f as any).tags) && (f as any).tags.some((t: string) => t.toLowerCase().includes(tagQ)));
    }
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((f) =>
      f.id.toLowerCase().includes(q) || f.title.toLowerCase().includes(q)
    );
    return out.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [features, view, search, projectFilter, tagFilter]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Keep focusIdx in bounds
  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, focusIdx]);

  // Keyboard navigation on the list panel when it has focus (or nothing else does)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip if user is typing in a text field
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        // Allow search focus
        if (e.key === 'Escape' && tgt === searchRef.current) {
          searchRef.current?.blur();
          e.preventDefault();
        }
        return;
      }
      // Skip if a modal is open (peek panel / dialog)
      if (document.querySelector('[data-harness-modal="true"]')) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const f = filtered[focusIdx];
        if (f) onSelect(f);
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        const f = filtered[focusIdx];
        if (f) onReset(f.id);
      } else if (e.key === 'x' || e.key === 'X') {
        const f = filtered[focusIdx];
        if (!f) return;
        setSelected((s) => {
          const next = new Set(s);
          if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, focusIdx, onReset, onSelect]);

  // Auto-scroll focused row into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-feat-idx="${focusIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const selectedArr = Array.from(selected);
  const hasSelection = selectedArr.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: filters + search + view mode + actions */}
      <div className="h-feature-toolbar">
        <span className="h-feature-toolbar-title">
          Feature Queue <strong>{features.length}</strong>
        </span>

        <div className="h-feature-viewbar" role="tablist" aria-label="Feature filters">
          {BUILT_IN_VIEWS.map((v) => {
            const active = v.id === viewId;
            const count = features.filter((f) => {
              if (v.filter.statuses && !v.filter.statuses.includes(f.status)) return false;
              if (v.filter.minAttempts != null && f.attempts < v.filter.minAttempts) return false;
              return true;
            }).length;
            return (
              <button
                key={v.id}
                className={`h-feature-filter${active ? ' active' : ''}`}
                onClick={() => setViewId(v.id)}
                aria-pressed={active}
                type="button"
              >
                <span>{v.name}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>

        <div className="h-feature-toolrow">
          <div className="h-feature-primary-filters">
            <Select
              value={projectFilter}
              onChange={setProjectFilter}
              ariaLabel="Filter by project"
              triggerClassName="h-feature-project-filter"
              contentStyle={{ minWidth: 160 }}
              options={[
                { value: 'all', label: 'All projects' },
                { value: '__none', label: 'No project' },
                ...projectOptions.map((pid) => ({ value: pid, label: pid })),
              ]}
            />

            <input
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Tag…"
              aria-label="Filter by tag"
              className="h-feature-tag-filter"
            />

            <div className="h-feature-search">
              <span className="h-feature-search-icon" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search features…"
                className="h-feature-search-input"
                aria-label="Search features"
              />
              {search && (
                <button
                  type="button"
                  className="h-feature-search-clear"
                  onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                  aria-label="Clear feature search"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="h-feature-secondary-tools">
            <Tooltip label="Filtered features">
              <span className="h-feature-result-count">
                {filtered.length}/{features.length} shown
              </span>
            </Tooltip>

            <div className="h-feature-mode" role="group" aria-label="View mode">
              {(['list', 'board'] as ViewMode[]).map((m) => {
                const active = mode === m;
                return (
                  <Tooltip key={m} label={`${m} view`}>
                    <button
                      className={`h-feature-mode-btn${active ? ' active' : ''}`}
                      onClick={() => setMode(m)}
                      aria-pressed={active}
                      type="button"
                    >
                      {m}
                    </button>
                  </Tooltip>
                );
              })}
            </div>

            <button type="button" className="h-feature-add" onClick={onAdd}>
              + new
            </button>
          </div>
        </div>
      </div>

      {/* Batch action bar */}
      {hasSelection && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px',
          background: 'rgba(94,106,210,0.12)',
          borderBottom: `1px solid ${COLORS.border}`,
          fontSize: SIZES.xs, color: COLORS.text,
          flexShrink: 0,
        }}>
          <span>{selectedArr.length} selected</span>
          <IconButton onClick={() => { onBatchReset(selectedArr); setSelected(new Set()); }} variant="subtle">Reset all</IconButton>
          <IconButton onClick={() => { if (confirm(`Delete ${selectedArr.length} features?`)) { onBatchDelete(selectedArr); setSelected(new Set()); }}} variant="danger">Delete</IconButton>
          <IconButton onClick={() => setSelected(new Set())} variant="ghost">Clear</IconButton>
        </div>
      )}

      {/* Body */}
      <div ref={listRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 24, color: COLORS.textDim, fontSize: SIZES.sm, textAlign: 'center' }}>
            {features.length === 0 ? 'No features yet — planner may still be running.' : 'No features match this view.'}
          </div>
        ) : mode === 'list' ? (
          <ListView
            slug={slug}
            features={filtered}
            focusIdx={focusIdx}
            activeId={activeFeatureId}
            selected={selected}
            onSelect={onSelect}
            onToggleSelect={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onReset={onReset}
            onEdit={onEdit}
            onOpenInPi={onOpenInPi}
            onSwitchToPi={onSwitchToPi}
            compact={isCompact}
          />
        ) : (
          <BoardView
            features={filtered}
            activeId={activeFeatureId}
            selected={selected}
            onSelect={onSelect}
            onToggleSelect={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          />
        )}
      </div>

      {/* Footer keyboard hints */}
      <div style={{
        display: 'flex', gap: 10, padding: '4px 10px',
        borderTop: `1px solid ${COLORS.borderSubtle}`,
        fontSize: '0.65rem', color: COLORS.textDim,
        flexShrink: 0,
      }}>
        <span><KbdHint>J/K</KbdHint> move</span>
        <span><KbdHint>↵</KbdHint> open</span>
        <span><KbdHint>R</KbdHint> reset</span>
        <span><KbdHint>X</KbdHint> select</span>
        <span><KbdHint>/</KbdHint> search</span>
      </div>
    </div>
  );
}

// ─── List view ─────────────────────────────────────────────────────

function ListView({
  slug, features, focusIdx, activeId, selected, onSelect, onToggleSelect, onReset, onEdit, onOpenInPi, onSwitchToPi, compact = false,
}: {
  slug: string;
  features: Feature[];
  focusIdx: number;
  activeId: string | null;
  selected: Set<string>;
  onSelect: (f: Feature) => void;
  onToggleSelect: (id: string) => void;
  onReset: (id: string) => void;
  onEdit: (f: Feature) => void;
  onOpenInPi?: (id: string) => void;
  onSwitchToPi?: () => void;
  compact?: boolean;
}) {
  const [noteFeatureId, setNoteFeatureId] = useState<string | null>(null);
  const [chatBusyId, setChatBusyId] = useState<string | null>(null);
  const [chatError, setChatError] = useState<{ id: string; message: string } | null>(null);

  const startChat = useCallback(async (row: Feature) => {
    if (!slug) return;
    setChatBusyId(row.id);
    setChatError(null);
    try {
      const res = await openFeatureChat({
        slug,
        role: 'worker',
        featureId: row.id,
        title: row.summary || row.title,
      });
      if ('error' in res) {
        setNoteFeatureId(row.id);
        setChatError({ id: row.id, message: res.error });
        return;
      }
      onSwitchToPi?.();
    } finally {
      setChatBusyId(null);
    }
  }, [slug, onSwitchToPi]);
  const columns: ColumnDef<Feature>[] = useMemo(() => {
    const cols: ColumnDef<Feature>[] = [
      {
        key: 'select',
        header: '',
        width: 0.18,
        align: 'center',
        render: ({ row }) => (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
            <Checkbox
              checked={selected.has(row.id)}
              onChange={() => onToggleSelect(row.id)}
              ariaLabel={`Select ${row.id}`}
            />
          </span>
        ),
      },
    ];
    if (!compact) {
      cols.push({
        key: 'statusDot',
        header: '',
        width: 0.18,
        align: 'center',
        render: ({ row }) => <StatusPill status={row.status} showLabel={false} size="xs" />,
      });
      cols.push({
        key: 'id',
        header: 'ID',
        width: 0.7,
        render: ({ row }) => (
          <span style={{
            fontFamily: FONTS.mono,
            fontSize: SIZES.xs,
            color: COLORS.textMuted,
            letterSpacing: '0.02em',
          }}>{row.id}</span>
        ),
      });
    }
    cols.push({
      key: 'title',
      header: compact ? 'Feature' : 'Title',
      width: compact ? 4 : 3.15,
      render: ({ row }) => {
        const claimsCount = row.claims?.length ?? 0;
        if (compact) {
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, width: '100%' }}>
              <span className="h-feature-row-title" title={row.title} style={{
                color: COLORS.text, fontSize: SIZES.sm,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{row.summary || row.title}</span>
              <span className="h-feature-row-meta" style={{ display: 'flex', alignItems: 'center', gap: 7, color: COLORS.textDim, fontSize: SIZES.xs }}>
                <StatusPill status={row.status} showLabel={false} size="xs" />
                <span className="h-feature-row-id" style={{ fontFamily: FONTS.mono, color: COLORS.textMuted }}>{row.id}</span>
                {claimsCount > 0 && <span>{claimsCount} claims</span>}
                {row.attempts > 0 && (
                  <span style={{
                    marginLeft: 'auto',
                    fontFamily: FONTS.mono,
                    color: row.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim,
                  }}>×{row.attempts}</span>
                )}
              </span>
            </div>
          );
        }
        return (
          <span className="h-feature-row-main" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, width: '100%' }}>
            <span className="h-feature-row-title" title={row.title} style={{
              color: COLORS.text, fontSize: SIZES.sm,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{row.summary || row.title}</span>
            {claimsCount > 0 && (
              <span className="h-feature-claims-chip" style={{
                fontSize: '0.65rem', color: COLORS.textDim, background: COLORS.bg,
                padding: '1px 6px', borderRadius: RADIUS.sm,
                border: `1px solid ${COLORS.borderSubtle}`, flexShrink: 0,
              }}>{claimsCount} claims</span>
            )}
          </span>
        );
      },
    });
    if (!compact) {
      cols.push({
        key: 'attempts',
        header: 'Try',
        width: 0.4,
        align: 'right',
        render: ({ row }) => (
          <span style={{
            fontFamily: FONTS.mono,
            fontSize: SIZES.xs,
            color: row.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim,
          }}>{row.attempts}</span>
        ),
      });
    }
    cols.push({
      key: 'status',
      header: 'Status',
      width: compact ? 0.7 : 0.78,
      align: 'right',
      render: ({ row }) => (
        <span className="h-feature-status-text">{getStatusMeta(row.status).label}</span>
      ),
    });
    if (!compact) {
      cols.push({
        key: 'actions',
        header: '',
        width: 2.08,
        align: 'right',
        render: ({ row }) => {
          const noteOpen = noteFeatureId === row.id;
          const chatBusy = chatBusyId === row.id;
          return (
            <div className="h-feature-row-actions" onClick={(e) => e.stopPropagation()}>
              <Tooltip label="Steer this feature — expands an inline note area for the worker">
                <button
                  type="button"
                  className={`h-feature-row-action${noteOpen ? ' active' : ''}`}
                  aria-expanded={noteOpen}
                  onClick={() => setNoteFeatureId(noteOpen ? null : row.id)}
                >
                  steer
                </button>
              </Tooltip>
              <Tooltip label="Open a worker chat for this feature in consoles">
                <button
                  type="button"
                  className="h-feature-row-action"
                  disabled={chatBusy}
                  onClick={() => void startChat(row)}
                >
                  {chatBusy ? 'chat…' : 'chat'}
                </button>
              </Tooltip>
              <Tooltip label="Open this feature in the Pi console lane">
                <button type="button" className="h-feature-row-action" onClick={() => onOpenInPi?.(row.id)}>
                  open in pi
                </button>
              </Tooltip>
              <Tooltip label="Edit this feature">
                <button type="button" className="h-feature-row-action" onClick={() => onEdit(row)}>
                  edit
                </button>
              </Tooltip>
              <Tooltip label="Reset this feature to todo">
                <button type="button" className="h-feature-row-action danger" onClick={() => onReset(row.id)}>
                  reset
                </button>
              </Tooltip>
            </div>
          );
        },
      });
    }
    return cols;
  }, [chatBusyId, compact, noteFeatureId, onEdit, onOpenInPi, onReset, onToggleSelect, selected, startChat]);

  // Map per-row aria/data attributes + per-row background to mirror the
  // pre-RichGrid behaviour (focus ring on keyboard focus, active row tint,
  // selected row bg).
  const richRowProps = useMemo(() => {
    return (ctx: { row: Feature; rowIndex: number }) => {
      const f = ctx.row;
      const i = ctx.rowIndex;
      const isFocus = i === focusIdx;
      const isActive = f.id === activeId;
      const isSel = selected.has(f.id);
      const isNoteOpen = f.id === noteFeatureId;
      const cls =
        `h-feature-row status-${f.status}` +
        (compact ? ' compact' : '') +
        (isFocus ? ' is-focused' : '') +
        (isActive ? ' is-active' : '') +
        (isSel ? ' is-selected' : '') +
        (isNoteOpen ? ' is-steering' : '');
      const collapseOnLeave = isNoteOpen ? {
        onPointerLeave: () => setNoteFeatureId(null),
        onMouseOut: (e: any) => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setNoteFeatureId(null);
        },
      } : {};
      return {
        className: cls,
        tabIndex: 0,
        'aria-label': `${f.id}: ${f.summary || f.title} (${getStatusMeta(f.status).label})`,
        'data-feat-idx': i,
        ...collapseOnLeave,
      };
    };
  }, [activeId, compact, focusIdx, noteFeatureId, selected]);

  const richGetRowBg = useMemo(
    () => (row: Feature, _idx: number, _isSelected: boolean) => {
      const isActive = row.id === activeId;
      const isSel = selected.has(row.id);
      if (isSel) return 'rgba(94,106,210,0.10)';
      if (isActive) return COLORS.surfaceHover;
      return 'transparent';
    },
    [activeId, selected],
  );

  return (
    <RichGrid<Feature>
      rows={features}
      columns={columns}
      getRowId={(f) => f.id}
      onRowClick={(f) => onSelect(f)}
      rowProps={richRowProps}
      getRowBg={richGetRowBg}
      expandedRowKey={noteFeatureId}
      renderExpandedRow={(row) => (
        <div className="h-feature-inline-note" onClick={(e) => e.stopPropagation()}>
          <div className="h-feature-inline-note-head">
            <strong>Steer · {row.id}</strong>
            <button type="button" onClick={() => setNoteFeatureId(null)}>close</button>
          </div>
          {chatError?.id === row.id && (
            <div className="h-feature-inline-note-error">chat failed: {chatError.message}</div>
          )}
          <OperatorNoteForm slug={slug} featureId={row.id} />
        </div>
      )}
      inline
    />
  );
}

// ─── Board view ──────────────────────────────────────────────────

function BoardView({
  features, activeId, selected, onSelect, onToggleSelect,
}: {
  features: Feature[];
  activeId: string | null;
  selected: Set<string>;
  onSelect: (f: Feature) => void;
  onToggleSelect: (id: string) => void;
}) {
  const cols: Record<HarnessStatus, Feature[]> = {
    todo: [], in_progress: [], validating: [], failing: [], blocked: [], passed: [],
  };
  for (const f of features) cols[f.status].push(f);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${BOARD_COLUMN_ORDER.length}, minmax(160px, 1fr))`,
      gap: 6,
      padding: 8,
      height: '100%',
      overflowX: 'auto',
    }}>
      {BOARD_COLUMN_ORDER.map((st) => {
        const s = STATUS[st];
        const items = cols[st];
        return (
          <div key={st} style={{
            display: 'flex', flexDirection: 'column',
            minHeight: 0,
            background: COLORS.bg,
            border: `1px solid ${COLORS.borderSubtle}`,
            borderRadius: RADIUS.sm,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 8px',
              borderBottom: `1px solid ${COLORS.borderSubtle}`,
              flexShrink: 0,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.solid }} />
              <span style={{ fontSize: SIZES.xs, color: s.text, fontWeight: 600 }}>{s.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: SIZES.xs, color: COLORS.textDim }}>{items.length}</span>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {items.length === 0 ? (
                <div style={{ padding: 10, color: COLORS.textFaint, fontSize: SIZES.xs, textAlign: 'center' }}>—</div>
              ) : (
                items.map((f) => {
                  const isActive = f.id === activeId;
                  const isSel = selected.has(f.id);
                  return (
                    <div
                      key={f.id}
                      onClick={() => onSelect(f)}
                      style={{
                        padding: '6px 8px',
                        background: isSel ? 'rgba(94,106,210,0.15)' : COLORS.surfaceRaised,
                        border: `1px solid ${isActive ? COLORS.accent : COLORS.borderSubtle}`,
                        borderRadius: RADIUS.sm,
                        cursor: 'pointer',
                        fontSize: SIZES.xs,
                      }}
                    >
                      <div style={{
                        fontFamily: FONTS.mono,
                        color: COLORS.textDim,
                        fontSize: '0.65rem',
                        letterSpacing: '0.02em',
                        marginBottom: 2,
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                          <Checkbox
                            checked={isSel}
                            onChange={() => onToggleSelect(f.id)}
                            ariaLabel={`Select ${f.id}`}
                          />
                        </span>
                        {f.id}
                        {f.attempts > 0 && (
                          <span style={{
                            marginLeft: 'auto',
                            color: f.attempts >= 3 ? STATUS.blocked.text : COLORS.textDim,
                          }}>×{f.attempts}</span>
                        )}
                      </div>
                      <div
                        title={f.title}
                        style={{
                          color: COLORS.text,
                          fontSize: SIZES.xs,
                          lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {f.summary || f.title}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
