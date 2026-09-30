'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Proposal {
  id: string;
  sizeBytes: number;
  ts: number;
  status: 'pending' | 'applied' | 'rejected';
  reviewVerdict?: 'accept' | 'reject' | 'defer' | null;
  reviewedAt?: number | null;
  reviewSummary?: string | null;
}

interface Props {
  slug: string;
}

type ProposalStatus = Proposal['status'];
type StatusFilter = 'all' | ProposalStatus;
type SortMode = 'newest' | 'oldest' | 'largest' | 'smallest';
const STATUS_ORDER: ProposalStatus[] = ['pending', 'applied', 'rejected'];

const STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: 'Pending',
  applied: 'Applied',
  rejected: 'Rejected',
};

const STATUS_COPY: Record<ProposalStatus, string> = {
  pending: 'Needs a product decision',
  applied: 'Appended to SPEC.md',
  rejected: 'Declined / archived',
};

const STATUS_HINT: Record<ProposalStatus, string> = {
  pending: 'needs review',
  applied: 'in SPEC.md',
  rejected: 'kept out',
};

const SORT_LABEL: Record<SortMode, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Most detail',
  smallest: 'Least detail',
};

function fmtTs(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAge(ts: number): string {
  if (!ts) return 'unknown age';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return fmtTs(ts);
}


function humanizeId(id: string): string {
  const cleaned = id
    .replace(/\.(md|txt|json)$/i, '')
    .replace(/^proposal[-_:\s]*/i, '')
    .replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_:\s]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  return cleaned || id;
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));

  if (heading) return heading.replace(/^#{1,3}\s+/, '').trim();
  return humanizeId(fallback);
}

function compareProposal(a: Proposal, b: Proposal, sortMode: SortMode): number {
  if (sortMode === 'oldest') return a.ts - b.ts || a.id.localeCompare(b.id);
  if (sortMode === 'largest') return (b.sizeBytes || 0) - (a.sizeBytes || 0) || b.ts - a.ts;
  if (sortMode === 'smallest') return (a.sizeBytes || 0) - (b.sizeBytes || 0) || b.ts - a.ts;
  return b.ts - a.ts || a.id.localeCompare(b.id);
}

async function copyText(text: string): Promise<boolean> {
  try {
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    return true;
  } catch {
    return false;
  }
}

function shortlistKey(slug: string): string {
  return `harness.proposalShortlist.${slug}`;
}

function readShortlist(slug: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(shortlistKey(slug));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeShortlist(slug: string, ids: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(shortlistKey(slug), JSON.stringify([...ids]));
  } catch {}
}

export default function ProposalsPanel({ slug }: Props) {
  const [items, setItems] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [goal, setGoal] = useState<string>('');
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pendingReplanPrompt, setPendingReplanPrompt] = useState<number>(0);
  const [replanOnAccept, setReplanOnAccept] = useState<boolean>(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [shortlisted, setShortlisted] = useState<Set<string>>(() => readShortlist(slug));
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/proposals`).then((r) => r.json());
      const proposals = (d.proposals ?? []) as Proposal[];
      setItems(proposals);
      setReplanOnAccept(d.replanOnAccept !== false);
      setSelected((prev) => {
        if (prev && proposals.some((p) => p.id === prev)) return prev;
        return proposals[0]?.id ?? null;
      });
      setChecked((prev) => new Set([...prev].filter((id) => proposals.some((p) => p.id === id && p.status === 'pending'))));
      setShortlisted((prev) => new Set([...prev].filter((id) => proposals.some((p) => p.id === id))));
    } catch (e) {
      setToast(`load: ${e}`);
    }
  }, [slug]);

  const loadGoal = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/spec`).then((r) => r.json());
      setGoal(d.spec ?? '');
      setGoalDraft(d.spec ?? '');
    } catch {}
  }, [slug]);

  useEffect(() => {
    loadList();
    loadGoal();
    const t = setInterval(loadList, 10000);
    return () => clearInterval(t);
  }, [loadList, loadGoal]);

  useEffect(() => {
    setShortlisted(readShortlist(slug));
    setShortlistOnly(false);
  }, [slug]);

  useEffect(() => {
    writeShortlist(slug, shortlisted);
  }, [slug, shortlisted]);

  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }

    let cancelled = false;
    setContent('');
    fetch(`/api/harness/${slug}/proposals/${selected}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setContent(d.content ?? ''); })
      .catch(() => { if (!cancelled) setContent(''); });

    return () => { cancelled = true; };
  }, [slug, selected]);

  const saveGoal = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/spec`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: goalDraft }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setGoal(goalDraft);
      setEditingGoal(false);
      setToast('SPEC.md saved');
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, goalDraft]);

  const runProductReview = useCallback(async () => {
    if (!goal.trim()) {
      setToast('Set a SPEC.md first');
      setTimeout(() => setToast(null), 3000);
      return;
    }
    setBusy(true);
    setToast('Running scoper proposal pass (may take a few minutes)…');
    try {
      const r = await fetch(`/api/harness/${slug}/product-review`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `${r.status}`);
      setToast('scoper proposal pass complete');
      await loadList();
    } catch (e) {
      setToast(`scoper proposal pass failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, goal, loadList]);

  const accept = useCallback(async (id: string) => {
    if (!confirm(`Accept proposal ${id}? Its acceptance bullets will be appended to SPEC.md.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/proposals/${id}/accept`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `${r.status}`);
      setToast(`accepted: +${d.bulletsAdded} bullet(s) appended to SPEC.md`);
      setPendingReplanPrompt((prev) => prev + (d.bulletsAdded ?? 0));
      await loadList();
      if (selected === id) {
        fetch(`/api/harness/${slug}/proposals/${id}`).then((r) => r.json()).then((d) => setContent(d.content ?? '')).catch(() => {});
      }
    } catch (e) {
      setToast(`accept failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, loadList, selected]);

  const reject = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/proposals/${id}/reject`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      setToast('rejected');
      await loadList();
      if (selected === id) {
        fetch(`/api/harness/${slug}/proposals/${id}`).then((r) => r.json()).then((d) => setContent(d.content ?? '')).catch(() => {});
      }
    } catch (e) {
      setToast(`reject failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, loadList, selected]);

  const counts = useMemo(() => {
    const next = { all: items.length, pending: 0, applied: 0, rejected: 0, bytes: 0 };
    for (const item of items) {
      next[item.status] += 1;
      next.bytes += item.sizeBytes || 0;
    }
    return next;
  }, [items]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => {
        if (shortlistOnly && !shortlisted.has(item.id)) return false;
        if (statusFilter !== 'all' && item.status !== statusFilter) return false;
        if (!needle) return true;
        return item.id.toLowerCase().includes(needle) || humanizeId(item.id).toLowerCase().includes(needle) || item.status.includes(needle);
      })
      .sort((a, b) => compareProposal(a, b, sortMode));
  }, [items, query, shortlisted, shortlistOnly, sortMode, statusFilter]);

  const selectedItem = useMemo(() => items.find((p) => p.id === selected) ?? null, [items, selected]);
  const selectedIndex = useMemo(() => filteredItems.findIndex((p) => p.id === selected), [filteredItems, selected]);
  const pendingIds = useMemo(() => items.filter((p) => p.status === 'pending').map((p) => p.id), [items]);
  const visiblePendingIds = useMemo(() => filteredItems.filter((p) => p.status === 'pending').map((p) => p.id), [filteredItems]);
  const checkedPending = useMemo(() => pendingIds.filter((id) => checked.has(id)), [pendingIds, checked]);
  const checkedVisiblePending = useMemo(() => visiblePendingIds.filter((id) => checked.has(id)), [visiblePendingIds, checked]);
  const nextPending = useMemo(() => items
    .filter((p) => p.status === 'pending')
    .sort((a, b) => compareProposal(a, b, sortMode))[0] ?? null, [items, sortMode]);

  const contentStats = useMemo(() => {
    const lines = content.split('\n');
    const nonEmpty = lines.filter((line) => line.trim()).length;
    const bullets = lines.filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line)).length;
    const outline = lines
      .map((line) => line.trim())
      .filter((line) => /^#{2,3}\s+\S/.test(line))
      .map((line) => line.replace(/^#{2,3}\s+/, '').trim())
      .filter(Boolean)
      .slice(0, 6);
    const signals = lines.filter((line) => /(risk|trade-?off|constraint|dependency|validation|metric|rollout|test)/i.test(line)).length;
    return {
      nonEmpty,
      bullets,
      outline,
      signals,
      title: selectedItem ? titleFromContent(content, selectedItem.id) : 'Select a proposal',
    };
  }, [content, selectedItem]);

  const bulkAccept = useCallback(async () => {
    if (checkedPending.length === 0) return;
    if (!confirm(`Accept ${checkedPending.length} proposal(s)? Each one's acceptance bullets will be appended to SPEC.md in order.`)) return;
    setBusy(true);
    let totalBullets = 0;
    let errors = 0;
    try {
      for (const id of checkedPending) {
        try {
          const r = await fetch(`/api/harness/${slug}/proposals/${id}/accept`, { method: 'POST' });
          const d = await r.json();
          if (r.ok) totalBullets += d.bulletsAdded ?? 0;
          else errors += 1;
        } catch {
          errors += 1;
        }
      }
      setChecked(new Set());
      setPendingReplanPrompt((prev) => prev + totalBullets);
      setToast(`bulk accept: +${totalBullets} bullets${errors ? `, ${errors} errors` : ''}`);
      await loadList();
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, checkedPending, loadList]);

  const bulkReject = useCallback(async () => {
    if (checkedPending.length === 0) return;
    if (!confirm(`Reject ${checkedPending.length} proposal(s)?`)) return;
    setBusy(true);
    try {
      for (const id of checkedPending) {
        try { await fetch(`/api/harness/${slug}/proposals/${id}/reject`, { method: 'POST' }); } catch {}
      }
      setChecked(new Set());
      setToast(`rejected ${checkedPending.length} proposal(s)`);
      await loadList();
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, checkedPending, loadList]);

  const replanNow = useCallback(async () => {
    if (!confirm('Run /replan now? Existing features (harness_features) + validation-contract.md are backed up and replaced.')) return;
    setBusy(true);
    setToast('Re-planning… (may take a few minutes)');
    try {
      const r = await fetch(`/api/harness/${slug}/replan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overwrite: true }),
      });
      const d = await r.json();
      if (d.ok && d.produced) {
        setToast(`re-planned — backup at ${d.backupDir}`);
        setPendingReplanPrompt(0);
      } else {
        setToast(`replan: ${d.error ?? 'did not produce artifacts'}`);
      }
    } catch (e) {
      setToast(`replan failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  }, [slug]);

  const toggleCheck = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleVisiblePending = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      const allVisibleChecked = visiblePendingIds.length > 0 && visiblePendingIds.every((id) => next.has(id));
      for (const id of visiblePendingIds) {
        if (allVisibleChecked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const selectRelative = useCallback((direction: number) => {
    if (filteredItems.length === 0) return;
    const currentIndex = selected ? filteredItems.findIndex((p) => p.id === selected) : -1;
    const fallbackIndex = direction > 0 ? 0 : filteredItems.length - 1;
    const nextIndex = currentIndex < 0
      ? fallbackIndex
      : (currentIndex + direction + filteredItems.length) % filteredItems.length;
    setSelected(filteredItems[nextIndex]?.id ?? null);
  }, [filteredItems, selected]);


  const focusNextPending = useCallback(() => {
    if (!nextPending) return;
    setQuery('');
    setStatusFilter('pending');
    setShortlistOnly(false);
    setSelected(nextPending.id);
  }, [nextPending]);

  const resetView = useCallback(() => {
    setQuery('');
    setStatusFilter('all');
    setSortMode('newest');
    setShortlistOnly(false);
  }, []);

  const copyProposal = useCallback(async () => {
    if (!content.trim()) return;
    const ok = await copyText(content);
    setToast(ok ? 'proposal markdown copied' : 'copy failed');
    setTimeout(() => setToast(null), 2200);
  }, [content]);

  const toggleShortlist = useCallback((id: string) => {
    setShortlisted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTextTarget = target && (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable);
      if (isTextTarget) {
        if (event.key === 'Escape') target.blur();
        return;
      }
      if (document.querySelector('[data-harness-modal="true"]')) return;

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        selectRelative(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        selectRelative(-1);
      } else if (event.key === 'n') {
        event.preventDefault();
        focusNextPending();
      } else if (event.key === 's' && selectedItem) {
        event.preventDefault();
        toggleShortlist(selectedItem.id);
      } else if (event.key === 'x' && selectedItem?.status === 'pending') {
        event.preventDefault();
        toggleCheck(selectedItem.id);
      } else if (event.key === 'c' && content.trim()) {
        event.preventDefault();
        copyProposal();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, copyProposal, focusNextPending, selectRelative, selectedItem, toggleCheck, toggleShortlist]);

  const statusCount = (status: StatusFilter) => (status === 'all' ? counts.all : counts[status]);
  const toastKind = toast && /failed|error|reject/i.test(toast) ? 'bad' : 'good';
  const hasGoal = goal.trim().length > 0;
  const detailActionHint = selectedItem?.status === 'pending'
    ? 'Apply writes this proposal to SPEC.md. Reject keeps it out of the plan.'
    : selectedItem?.status === 'applied'
      ? 'Already applied to SPEC.md. Copy markdown if you want to reuse the proposal text.'
      : selectedItem?.status === 'rejected'
        ? 'Rejected proposals stay out of SPEC.md. Copy markdown if you want to revisit it later.'
        : 'Select a proposal to preview the details and choose an action.';

  return (
    <div className="h-proposals-panel" data-proposals-panel>
      <div className={`h-proposals-goal ${editingGoal ? 'is-editing' : ''}`}>
        <div className="h-proposals-goal-head">
          <span>SPEC.md</span>
          {!editingGoal && (
            <span className={`h-proposals-goal-preview ${hasGoal ? '' : 'empty'}`}>
              {goal || 'Set a north-star goal before proposing scope.'}
            </span>
          )}
          <span className="h-proposals-goal-meta">{hasGoal ? `${goal.trim().length} chars` : 'empty'}</span>
          <div className="h-proposals-goal-actions">
            {editingGoal ? (
              <>
                <button type="button" onClick={saveGoal} disabled={busy} className="h-proposal-btn primary">save</button>
                <button type="button" onClick={() => { setEditingGoal(false); setGoalDraft(goal); }} className="h-proposal-btn ghost">cancel</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setEditingGoal(true)} className="h-proposal-btn ghost">edit goal</button>
                <button
                  type="button"
                  onClick={runProductReview}
                  disabled={busy || !hasGoal}
                  title={!hasGoal ? 'Set a SPEC.md first' : 'Run the scoper agent (MODE=proposal) to propose new scope'}
                  className="h-proposal-btn primary"
                >
                  {busy ? 'working…' : 'generate proposals'}
                </button>
              </>
            )}
          </div>
        </div>
        {editingGoal && (
          <div className="h-proposals-goal-editor">
            <textarea
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              rows={2}
              aria-label="Edit SPEC.md"
            />
          </div>
        )}
      </div>

      {toast && (
        <div className={`h-proposal-toast ${toastKind}`}>
          <span>{toastKind === 'bad' ? '!' : '✓'}</span>
          {toast}
        </div>
      )}

      {pendingReplanPrompt > 0 && !replanOnAccept && (
        <div className="h-proposal-replan">
          <span><b>{pendingReplanPrompt}</b> new acceptance bullet(s) appended to SPEC.md. Run <code>/replan</code> to regenerate features + contract.</span>
          <button type="button" onClick={replanNow} disabled={busy} className="h-proposal-btn primary">{busy ? '…' : 'replan now'}</button>
          <button type="button" onClick={() => setPendingReplanPrompt(0)} className="h-proposal-btn ghost">dismiss</button>
        </div>
      )}

      <div className="h-proposals-workbench">
        <aside className="h-proposals-sidebar" aria-label="Proposal list">
          <div className="h-proposal-toolbar">
            <div className="h-proposal-toolbar-main">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search proposals…"
                aria-label="Search proposals"
                className="h-proposal-search"
              />
              <label className="h-proposal-sort">
                <span>Sort</span>
                <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} aria-label="Sort proposals">
                  {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
                    <option key={mode} value={mode}>{SORT_LABEL[mode]}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="h-proposal-toolbar-controls" aria-label="Proposal queue tools">
              <div className="h-proposal-filter-row" role="tablist" aria-label="Filter proposals by status">
                {(['all', ...STATUS_ORDER] as StatusFilter[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === status}
                    onClick={() => setStatusFilter(status)}
                    className={`h-proposal-filter ${statusFilter === status ? 'on' : ''} ${status !== 'all' ? `status-${status}` : ''}`}
                    aria-label={status === 'all'
                      ? `All proposals, ${statusCount(status)} total`
                      : `${STATUS_LABEL[status]} proposals: ${STATUS_HINT[status]}, ${statusCount(status)} total`}
                  >
                    <span>{status === 'all' ? 'All' : STATUS_LABEL[status]}<small>{status === 'all' ? 'entire queue' : STATUS_HINT[status]}</small></span>
                    <b>{statusCount(status)}</b>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShortlistOnly((on) => !on)}
                disabled={shortlisted.size === 0}
                className={`h-proposal-mini ghost ${shortlistOnly ? 'on' : ''}`}
              >
                starred {shortlisted.size}
              </button>
              {(query || statusFilter !== 'all' || sortMode !== 'newest' || shortlistOnly) && (
                <button type="button" onClick={resetView} className="h-proposal-mini ghost">reset view</button>
              )}
              <div className="h-proposal-hotkeys" aria-hidden="true">
                <kbd>/</kbd><span>search</span>
                <kbd>j/k</kbd><span>move</span>
                <kbd>n</kbd><span>pending</span>
                <kbd>s</kbd><span>star</span>
                <kbd>x</kbd><span>select</span>
                <kbd>c</kbd><span>copy</span>
              </div>
            </div>
          </div>

          {visiblePendingIds.length > 0 && (
            <label className="h-proposal-select-all">
              <input
                type="checkbox"
                checked={checkedVisiblePending.length === visiblePendingIds.length && visiblePendingIds.length > 0}
                onChange={toggleVisiblePending}
              />
              <span>{checkedVisiblePending.length > 0 ? `${checkedVisiblePending.length} selected` : `Select ${visiblePendingIds.length} pending proposals`}</span>
            </label>
          )}

          {checkedPending.length > 0 && (
            <div className="h-proposal-bulkbar">
              <span><b>{checkedPending.length}</b> pending selected</span>
              <button type="button" onClick={bulkAccept} disabled={busy} className="h-proposal-mini good">apply selected</button>
              <button type="button" onClick={bulkReject} disabled={busy} className="h-proposal-mini bad">reject selected</button>
              <button type="button" onClick={() => setChecked(new Set())} className="h-proposal-mini ghost">clear</button>
            </div>
          )}

          <div className="h-proposal-list" role="list">
            {items.length === 0 ? (
              <div className="h-proposal-empty">
                <b>No proposals yet</b>
                <span>Click <em>generate proposals</em> to have the scoper agent (MODE=proposal) read SPEC.md and suggest scoped features.</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="h-proposal-empty">
                <b>No matches</b>
                <span>Try another search term or status filter.</span>
              </div>
            ) : (
              filteredItems.map((p) => {
                const isActive = selected === p.id;
                const isPending = p.status === 'pending';
                const isChecked = checked.has(p.id);
                const isShortlisted = shortlisted.has(p.id);
                const rowTitle = humanizeId(p.id);
                const rowMeta = `${STATUS_LABEL[p.status]} · ${fmtTs(p.ts)} · ${STATUS_COPY[p.status]}`;
                const isoTs = p.ts ? new Date(p.ts).toISOString() : undefined;
                return (
                  <div
                    key={p.id}
                    className={`h-proposal-item status-${p.status} ${isActive ? 'is-active' : ''} ${isShortlisted ? 'is-shortlisted' : ''}`}
                    role="listitem"
                    aria-current={isActive ? 'true' : undefined}
                  >
                    {isPending ? (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => { e.stopPropagation(); toggleCheck(p.id); }}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select proposal ${p.id}`}
                        className="h-proposal-check"
                      />
                    ) : (
                      <span className="h-proposal-item-spacer" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={`h-proposal-pin ${isShortlisted ? 'on' : ''}`}
                      aria-label={`${isShortlisted ? 'Remove from' : 'Add to'} proposal shortlist`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleShortlist(p.id);
                      }}
                    >
                      ★
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(p.id)}
                      className="h-proposal-row-button"
                      title={rowMeta}
                      aria-label={`${rowTitle} — ${rowMeta}`}
                    >
                      <span className="h-proposal-row-title">{rowTitle}</span>
                      <span className={`h-proposal-badge status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                      {p.reviewVerdict && (
                        <span
                          className={`h-proposal-badge review-${p.reviewVerdict}`}
                          title={p.reviewSummary ?? `reviewer: ${p.reviewVerdict}`}
                        >
                          {p.reviewVerdict === 'accept' ? 'auto-accepted' : `reviewer: ${p.reviewVerdict}`}
                        </span>
                      )}
                      <time className="h-proposal-row-age" dateTime={isoTs}>{fmtAge(p.ts)}</time>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <section className="h-proposal-detail" aria-label="Proposal detail">
          {selectedItem ? (
            <>
              <div className={`h-proposal-detail-head status-${selectedItem.status}`}>
                <div className="h-proposal-detail-title">
                  <span className={`h-proposal-badge status-${selectedItem.status}`}>{STATUS_LABEL[selectedItem.status]}</span>
                  {selectedItem.reviewVerdict && (
                    <span className={`h-proposal-badge review-${selectedItem.reviewVerdict}`}>
                      {selectedItem.reviewVerdict === 'accept'
                        ? 'auto-accepted by reviewer'
                        : `reviewer: ${selectedItem.reviewVerdict}`}
                    </span>
                  )}
                  <h3>{contentStats.title}</h3>
                  <p>{selectedItem.id}</p>
                  {selectedItem.reviewSummary && (
                    <p className="h-proposal-review-summary" title={selectedItem.reviewSummary}>
                      <em>reviewer:</em> {selectedItem.reviewSummary}
                    </p>
                  )}
                </div>
                <div className="h-proposal-detail-metrics">
                  <span><b>{contentStats.bullets}</b> bullets</span>
                  <span><b>{contentStats.nonEmpty}</b> lines</span>
                  <span><b>{contentStats.signals}</b> signals</span>
                  <span>{fmtTs(selectedItem.ts)}</span>
                  {selectedIndex >= 0 && <span><b>{selectedIndex + 1}</b>/{filteredItems.length}</span>}
                </div>
                <div className="h-proposal-detail-actions">
                  <button
                    type="button"
                    onClick={() => toggleShortlist(selectedItem.id)}
                    className={`h-proposal-btn ghost h-proposal-shortlist-detail ${shortlisted.has(selectedItem.id) ? 'on' : ''}`}
                  >
                    {shortlisted.has(selectedItem.id) ? 'starred' : 'star for later'}
                  </button>
                  <button type="button" onClick={copyProposal} disabled={!content.trim()} className="h-proposal-btn ghost">copy markdown</button>
                  {selectedItem.status === 'pending' && (
                    <>
                      <button type="button" onClick={() => accept(selectedItem.id)} disabled={busy} className="h-proposal-btn good">apply to SPEC.md</button>
                      <button type="button" onClick={() => reject(selectedItem.id)} disabled={busy} className="h-proposal-btn danger">reject proposal</button>
                    </>
                  )}
                </div>
                <div className={`h-proposal-action-hint status-${selectedItem.status}`}>{detailActionHint}</div>
              </div>
              {(contentStats.outline.length > 0 || contentStats.signals > 0) && (
                <div className="h-proposal-outline" aria-label="Proposal outline">
                  <span>outline</span>
                  {contentStats.outline.map((heading, index) => (
                    <b key={`${heading}-${index}`}>{heading}</b>
                  ))}
                  {contentStats.signals > 0 && <em>{contentStats.signals} review signal{contentStats.signals === 1 ? '' : 's'}</em>}
                </div>
              )}
              <div className="h-proposal-doc-shell">
                {content ? (
                  <pre className="h-proposal-doc">{content}</pre>
                ) : (
                  <div className="h-proposal-loading">loading proposal…</div>
                )}
              </div>
            </>
          ) : (
            <div className="h-proposal-detail-empty">
              <b>Select a proposal</b>
              <span>The detail pane shows the proposal body, acceptance bullets, and decision actions.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}