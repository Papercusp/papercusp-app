'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useEffect, useState, useCallback, useMemo, useRef, type ReactElement } from 'react';
import { useQueryState, parseAsString, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

/**
 * Ceiling on the Settings → Memory envelope fetches (WI-5030). Generous enough
 * to absorb a genuine cold start (GET /api/user/memory/backend measured >12s
 * cold on source-run operators, ~0.08s bundled) while still guaranteeing the
 * page resolves to *something* rather than spinning forever.
 */
export const META_FETCH_TIMEOUT_MS = 20_000;

/**
 * Opening row window for the Memory settings page (EI-12937). Measured live:
 * the corpus was 1,140 rows / 2.02MB when the bound was introduced, and 2,465
 * by 2026-08-16 — so the bound is load-bearing and stays. The `full=true` URL
 * param (the "Show all" toggle) bypasses it and reproduces the exact pre-fix
 * unbounded fetch.
 *
 * ⚠ THIS IS A WINDOW, NOT A TOTAL — and the page MUST render it beside a
 * denominator (WI-39540). Shown alone, a saturated window is indistinguishable
 * from a measurement: the owner read "300 memories" off a 2,465-row corpus and
 * reasonably concluded most of their history had gone missing. A cap without
 * its denominator is a number that lies by omission, so `userMemory.total`
 * exists purely to keep this honest. If you change this value, keep the pair.
 */
export const DEFAULT_MEMORY_PAGE_LIMIT = 500;

/**
 * How much more to load each time the reader reaches the bottom. Infinite
 * scroll replaced the single "Show all" cliff — that button remains as an
 * explicit "load everything now" escape, but reaching the end of the list no
 * longer requires noticing a button to continue.
 */
export const MEMORY_PAGE_STEP = 500;
import { Select } from '@/app/harness/Select';
import { FleetKnowledgePacksSection } from './FleetKnowledgePacksSection';
import { EmbedDeviceSection } from './EmbedDeviceSection';
import { JevSection } from './JevSection';
import { MEMORY_KIND_COLOR, MEMORY_KIND_FALLBACK } from '@/app/harness/theme';
import { useLexicon } from '@/lib/useLexicon';
import { originOf, agentSourceDetailOf, type MemoryOrigin } from './origin';
import { possibleSecretClasses, possibleSecretTitle } from './possible-secret';
import { recallHealthLine, type RecallCanaryLatest } from './recall-health';
import { memoryWindowState } from './window';
import { reembedConfirmationBody } from './reembed-copy';

interface BrokenAnchor {
  kind: string;
  value: string;
  reason: string | null;
}

interface AuditFields {
  state: string;
  last_validated_at: string | null;
  last_surfaced_at: string | null;
  broken_anchors: BrokenAnchor[];
}

// Write-ahead journal status (memory-write-journal-auto-recovery P-006):
// shape served by the userMemory.journalStatus sync resolver.
interface JournalStatus {
  pending: number;
  failedPermanent: number;
  lastRecovery: { count: number; from: string; to: string; lastAt: string } | null;
}

// The neutral memory entry shape served by /api/user/memory
// (generalize-memory-backend-swappable D-003) — backend-agnostic:
// text/kind at the top level, never a mem0 row.
interface MemoryRow {
  id: string;
  text: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
  created_at?: string | null;
  updated_at?: string | null;
  audit?: AuditFields;
}

const STATE_BADGES: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  active:        { label: 'verified',           icon: '✓', color: 'var(--good)', bg: 'color-mix(in srgb, var(--good), transparent 85%)' },
  broken_anchor: { label: 'broken anchor',      icon: '⚠', color: 'var(--warn)', bg: 'var(--warn-bg)' },
  superseded:    { label: 'superseded',         icon: '🔄', color: 'var(--accent)', bg: 'color-mix(in srgb, var(--accent), transparent 85%)' },
  contradicted: { label: 'contradicted',       icon: '❌', color: 'var(--bad)', bg: 'color-mix(in srgb, var(--bad), transparent 85%)' },
  forgotten:     { label: 'forgotten',          icon: '🗑', color: 'var(--fg-mute)', bg: 'color-mix(in srgb, var(--fg-mute), transparent 85%)' },
};

function isFlagged(row: MemoryRow): boolean {
  const state = row.audit?.state ?? 'active';
  return state !== 'active';
}

/** Compact relative timestamp — '3d ago', 'just now'. */
function timeAgo(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Bodies longer than this render collapsed until the row is expanded. */
const COLLAPSE_OVER = 280;
const COLLAPSED_PREVIEW = 240;

// The `userMemory.feedbackStats` sync resolver's row shape
// (all-active-surfaces-data-sync-migration-2026-07-11 P-013) — lifetime
// edit/delete counts for the acting user, live-updated on every
// recordFeedback() write (user edits/deletes on this page AND agent-tool
// memory:update/memory:forget calls).
interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
}

/**
 * Per-mode copy for the "Active store" selector
 * (memory-declaude-and-defaults-2026-07-28 P-005).
 *
 * This replaced a single line that described `claude-file` as "your real Claude
 * Code memory" and named only 2 of the 5 then-selectable modes. Both halves were
 * a problem: the file-backed stores had already been retired (their topic files
 * stopped being load-bearing 2026-07-13), and a user comparing the unexplained
 * options had no way to know that the difference between them is RANKING, not
 * storage — which is the question people actually ask before switching.
 *
 * Keyed by the registered backend name and rendered from `availableBackends`, so
 * retiring or adding a backend changes this list without a second edit here; an
 * unknown name still renders, just without prose.
 */
const BACKEND_DOCS: Record<string, { label: string; summary: string }> = {
  'hybrid-pg': {
    label: 'hybrid-pg (recommended)',
    summary:
      'Two searches over the same store, fused: a semantic one that matches meaning and paraphrases, ' +
      'plus an exact-text one that reliably finds identifiers (WI-4522, PAPERCUSP_MEMORY_TIMEOUT, tool names) — ' +
      'which semantic search alone tends to blur. Best recall by a wide margin: 98% vs 53% on a 40-pair ' +
      'live comparison, for roughly +0.25s per search.',
  },
  mem0: {
    label: 'mem0',
    summary:
      'Semantic search only. About 0.25s faster per search, but it misses exact identifiers the ' +
      'vector space blurs together — 53% recall on the same comparison. Prefer hybrid-pg unless ' +
      'search latency is the thing you are optimizing.',
  },
  noop: {
    label: 'noop (memory off)',
    summary:
      'Turns the store off. Reads return nothing and writes fail loudly rather than silently ' +
      'dropping facts. Nothing already stored is deleted.',
  },
};

/** Kind suggestions for the add form — the unified taxonomy
 * (memory-taxonomy-and-debt-followups D-001); free text also accepted. */
const KIND_SUGGESTIONS = ['user', 'feedback', 'project', 'reference'];

export default function MemoryPage() {
  const t = useLexicon();
  const [userId, setUserId] = useState<string | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  // EI/WI-5030: why the envelope fetch failed, so a slow/hung backend renders an
  // actionable error instead of an eternal "Loading…". null = no error.
  const [metaError, setMetaError] = useState<string | null>(null);
  // Learning-instruction text: a derived-text snapshot (buildLearningInstructions),
  // not a live counter — stays a one-shot REST fetch, same class as the
  // backend/filesystem envelope below (P-013).
  const [learningInstructions, setLearningInstructions] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [reason, setReason] = useState<string | null>(null);
  const [backendName, setBackendName] = useState<string | null>(null);
  const [availableBackends, setAvailableBackends] = useState<string[]>([]);
  const [currentBackend, setCurrentBackend] = useState<string>('');
  const [switchingBackend, setSwitchingBackend] = useState(false);
  // URL-backed view state (nuqs) so agents can read + drive the page and
  // the view survives reloads. Lifecycle/edit-draft state stays useState.
  const [filter, setFilter] = useQueryState('kind', parseAsString.withDefault('all'));
  const [flaggedOnly, setFlaggedOnly] = useQueryState('flagged', parseAsBoolean.withDefault(false));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [expandedId, setExpandedId] = useQueryState('mem', parseAsString);
  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [semantic, setSemantic] = useQueryState('sem', parseAsBoolean.withDefault(false));
  // EI-12937: default to a bounded recent window instead of shipping the entire
  // corpus (measured live: 2.02MB / 1,140 rows) on every page load. `full=true`
  // reproduces the exact pre-fix unbounded fetch — an explicit opt-in, not a
  // removed capability, so search/filter across full history still works when needed.
  const [showAll, setShowAll] = useQueryState('full', parseAsBoolean.withDefault(false));
  const [auditBusy, setAuditBusy] = useState<boolean>(false);
  const [harnesses, setHarnesses] = useState<string[]>([]);
  // EI-10355: the "stop remembering things about me" switch. Paused ⇒ agents
  // write no NEW memories; everything already stored stays readable, editable,
  // deletable and exportable (a pause must never lock you out of your own data).
  const [paused, setPaused] = useState(false);
  const [pausing, setPausing] = useState(false);
  // EI-10368: latest live recall-canary run (null = never ran / unreadable) —
  // rides the same backend envelope; rendered as the "Recall health" line.
  const [recallCanary, setRecallCanary] = useState<RecallCanaryLatest | null>(null);
  // Add-form drafts — mid-edit state, stays useState per the nuqs rules.
  const [draftText, setDraftText] = useState('');
  const [draftKind, setDraftKind] = useState('');
  const [draftScope, setDraftScope] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  // Semantic hits: memory id → relevance score (null = not in semantic mode).
  const [semHits, setSemHits] = useState<Map<string, number> | null>(null);

  // Envelope meta (backend selection + availability + session user) is a
  // one-shot REST fetch; the ROWS ride the audited @papercusp/sync path
  // below (P-007) and refresh themselves on server-side invalidates.
  const refreshMeta = useCallback(async () => {
    try {
      setMetaError(null);
      // WI-5030: these fetches MUST be bounded. `finally` only runs once the
      // awaited promise SETTLES, so a fetch that hangs (rather than fails)
      // never sets metaLoaded and the page spins forever with no error and no
      // recovery — the owner-reported symptom. /api/user/memory/backend is
      // measurably slow-to-cold on source-run operators (>12s on :3170/:3270
      // vs 0.08s on bundled :3070), so an unbounded wait is a real hazard, not
      // a theoretical one. The timeout converts a hang into a rejection, which
      // the catch below turns into a visible, retryable error.
      const [r, fs] = await Promise.all([
        fetch('/api/user/memory/backend', { signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) }),
        fetch('/api/user/memory/feedback', { signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) }),
      ]);
      if (r.ok) {
        const j = await r.json();
        setUserId(typeof j.userId === 'string' ? j.userId : null);
        setReason(j.reason ?? null);
        setBackendName(j.backend ?? null);
        setAvailableBackends(Array.isArray(j.availableBackends) ? j.availableBackends : []);
        setCurrentBackend(j.currentBackend ?? j.backend ?? '');
        setHarnesses(Array.isArray(j.harnesses) ? j.harnesses : []);
        setPaused(j.paused === true);
        setRecallCanary(j.recallCanary?.latest ?? null);
      }
      if (fs.ok) setLearningInstructions((await fs.json()).learning_instructions ?? null);
    } catch (err) {
      // A timeout surfaces as TimeoutError; anything else (offline, 5xx-thrown)
      // lands here too. Either way the user gets a reason + a retry, never a
      // silent spinner.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      setMetaError(
        timedOut
          ? `The memory backend did not respond within ${Math.round(META_FETCH_TIMEOUT_MS / 1000)}s.`
          : `Could not load memory settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setMetaLoaded(true);
    }
  }, []);

  useEffect(() => { void refreshMeta(); }, [refreshMeta]);

  // The row set — server writes (REST routes AND the memory:* MCP verbs)
  // fire notifySyncInvalidate('userMemory.list'), so agent-side edits
  // appear here live without manual refresh (P-008).
  // How many rows the window currently asks for. Grows as the reader scrolls
  // (WI-39540). Deliberately useState, not nuqs: this is a transient LOAD
  // depth, not a user-meaningful selection — putting it in the URL would make
  // a shared/reloaded link re-download however deep the last reader happened
  // to scroll, which is the cost the window exists to avoid.
  const [loadedLimit, setLoadedLimit] = useState(DEFAULT_MEMORY_PAGE_LIMIT);
  const { data: rows, loading: rowsLoading } = useSyncQuery<MemoryRow>({
    queryName: 'userMemory.list',
    // EI-12937: bounded by default; `showAll` (the "Show all" toggle, ?full=true)
    // omits `limit` entirely, reproducing the exact pre-fix unbounded fetch.
    args: { userId: userId ?? '', ...(showAll ? {} : { limit: loadedLimit }) },
    enabled: !!userId,
  });

  // The DENOMINATOR (WI-39540) — how many memories exist across the same
  // scopes the list reads. Same invalidation family as userMemory.list (see
  // invalidate-user-memory-views.ts), so it moves with the rows.
  const { data: totalRows } = useSyncQuery<{ total: number }>({
    queryName: 'userMemory.total',
    args: { userId: userId ?? '' },
    enabled: !!userId,
  });
  // null = not known YET. Never coerce to 0 — "Showing 500 of 0" is worse
  // than showing no denominator at all, and an unknown total must read as
  // unknown rather than as an emptiness claim.
  const totalMemories = totalRows?.[0]?.total ?? null;

  // Window arithmetic lives in ./window so it can be asserted directly —
  // see window.test.ts for the boundary cases (short page, unknown total,
  // total lagging a delete).
  const { hasMore, remaining, showDenominator } = memoryWindowState({
    loadedRows: rows.length,
    loadedLimit,
    total: totalMemories,
    showAll,
  });
  const possiblyMoreThanShown = hasMore;
  const loading = !metaLoaded || (!!userId && rowsLoading);

  // Infinite scroll: grow the window when the sentinel below the list comes
  // into view. `rootMargin` starts the next page slightly before the reader
  // actually hits bottom so the list rarely visibly stalls.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasMore || rowsLoading) return;
    if (typeof IntersectionObserver === 'undefined') return; // jsdom / SSR safety
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLoadedLimit((n) => n + MEMORY_PAGE_STEP);
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, rowsLoading]);

  // Reset the window depth while "Show all" is ON (where `loadedLimit` is
  // unused, because the args omit `limit` entirely). Doing it on the way IN
  // is what makes the way OUT correct: "Show recent only" then lands on the
  // opening window instead of whatever depth the reader had scrolled to
  // before, so the button actually shrinks the payload it promises to shrink.
  useEffect(() => {
    if (showAll) setLoadedLimit(DEFAULT_MEMORY_PAGE_LIMIT);
  }, [showAll]);

  // Write-ahead journal status (memory-write-journal-auto-recovery P-006):
  // "N pending" badge + "Memory recovered" banner. The journal drain fires
  // notifySyncInvalidate('userMemory.journalStatus'), so this updates live.
  const { data: journalRows } = useSyncQuery<JournalStatus>({
    queryName: 'userMemory.journalStatus',
    args: {},
  });
  const journal = journalRows?.[0] ?? null;

  // Lifetime feedback counts (all-active-surfaces-data-sync-migration-2026-07-11
  // P-013): the settings page's own edits/deletes AND agent-tool
  // memory:update/memory:forget writes fire notifySyncInvalidate('userMemory.feedbackStats')
  // (memory/feedback.ts's recordFeedback), so this updates live like the row set above.
  const { data: feedbackStatsRows } = useSyncQuery<FeedbackStats>({
    queryName: 'userMemory.feedbackStats',
    args: { userId: userId ?? '' },
    enabled: !!userId,
  });
  const feedbackStats = feedbackStatsRows?.[0] ?? null;

  const switchBackend = useCallback(async (choice: string) => {
    if (!choice || choice === currentBackend) return;
    setSwitchingBackend(true);
    try {
      const r = await fetch('/api/user/memory/backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: choice }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(`Switch failed: ${j.error ?? r.status}`);
        return;
      }
      setCurrentBackend(choice);
      if (j.availability && j.availability.ok === false) {
        toast.warning(`Switched to ${choice}, but it's unavailable: ${j.availability.reason}`);
      } else {
        toast.success(`Memory backend → ${choice}`);
      }
      await refreshMeta();
    } finally {
      setSwitchingBackend(false);
    }
  }, [currentBackend, refreshMeta]);

  /** EI-10355: pause / resume new memory writes for this user. */
  const togglePaused = useCallback(async (next: boolean) => {
    setPausing(true);
    try {
      const r = await fetch('/api/user/memory/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(`Could not ${next ? 'pause' : 'resume'} memory: ${j.error ?? r.status}`);
        return;
      }
      setPaused(j.paused === true);
      toast.success(
        j.paused
          ? 'Memory paused — nothing new will be remembered about you.'
          : 'Memory resumed — new facts will be remembered again.',
      );
    } finally {
      setPausing(false);
    }
  }, []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const onSaveEdit = useCallback(async (id: string) => {
    const r = await fetch('/api/user/memory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text: editingDraft }),
    });
    const j = await r.json().catch(() => ({} as { journaled?: boolean }));
    if (r.ok) {
      toast.success('Updated');
      setEditingId(null);
      // Rows refresh via the server's userMemory.list invalidate.
    } else if (j.journaled) {
      // WI-4208: the store is down/saturated but the edit is parked durably and
      // replays automatically — telling the user it "failed" would invite a
      // pointless retype (or make them think the correction was lost).
      toast.success('Saved — finishing indexing once the memory store recovers');
      setEditingId(null);
    } else {
      toast.error('Update failed');
    }
  }, [editingDraft]);

  const onDelete = useCallback(async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this memory?',
      body: 'This memory will be removed and a feedback entry recorded so the extractor learns to skip similar memories.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/user/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.ok) {
      toast.success('Deleted');
      // Rows AND the feedback-stats tile refresh via the server's sync
      // invalidate (userMemory.list + userMemory.feedbackStats) — no REST
      // re-fetch needed here.
    } else {
      toast.error('Delete failed');
    }
  }, [askConfirm]);

  const onForgetAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Delete ALL of your memories?',
      body: 'Workspace-shared entries are not affected. Type FORGET to confirm.',
      confirmLabel: 'Forget all',
      destructive: true,
      requireType: 'FORGET',
    });
    if (!ok) return;
    const r = await fetch('/api/user/memory?all=1', { method: 'DELETE' });
    if (r.ok) {
      const j = await r.json();
      toast.success(`Deleted ${j.deleted} memories`);
      await refreshMeta();
    }
  }, [refreshMeta, askConfirm]);

  const [reembedBusy, setReembedBusy] = useState<null | `${'openai' | 'local' | 'gemma' | 'harrier'}-to-${'openai' | 'local' | 'gemma' | 'harrier'}`>(null);
  const onReembed = useCallback(async (from: 'openai' | 'local' | 'gemma' | 'harrier', to: 'openai' | 'local' | 'gemma' | 'harrier') => {
    const ok = await askConfirm({
      title: `Re-embed memories from "${from}" → "${to}"?`,
      body: reembedConfirmationBody(to),
      confirmLabel: 'Re-embed',
    });
    if (!ok) return;
    setReembedBusy(`${from}-to-${to}` as typeof reembedBusy);
    try {
      const r = await fetch('/api/user/memory/reembed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const j = await r.json();
      if (r.ok) {
        toast.success(`Re-embedded ${j.reembedded} of ${j.totalSource} (${j.skipped} skipped, ${j.errors} errors) in ${Math.round(j.durationMs / 100) / 10}s`);
        await refreshMeta();
      } else {
        toast.error(`Re-embed failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Re-embed failed: ${(err as Error).message}`);
    } finally {
      setReembedBusy(null);
    }
  }, [refreshMeta, askConfirm]);

  const onAuditAll = useCallback(async () => {
    const ok = await askConfirm({
      title: 'Audit all memories?',
      body: 'Runs the structural anchor check (Layer 1). Free and fast — checks that files / plans / migrations referenced by your memories still exist. Results land as status badges below.',
      confirmLabel: 'Audit',
    });
    if (!ok) return;
    setAuditBusy(true);
    try {
      const r = await fetch('/api/user/memory/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (r.ok) {
        if (j.skipped) {
          toast.warning(`Audit skipped: ${j.reason}`);
        } else {
          toast.success(`Audit complete: ${j.summary ?? 'done'}`);
        }
        // Badge changes arrive via the audit route's invalidate.
      } else {
        toast.error(`Audit failed: ${j.message ?? j.error}`);
      }
    } catch (err) {
      toast.error(`Audit failed: ${(err as Error).message}`);
    } finally {
      setAuditBusy(false);
    }
  }, [askConfirm]);

  // Chips are derived from the kinds actually present (D-001) — the
  // taxonomy is the backend's, not the page's. Counts over ALL rows so
  // a chip doesn't vanish while it's the active filter.
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r.kind ?? 'untagged';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const kindChips = useMemo(
    () => [...kindCounts.keys()].sort((a, b) => (kindCounts.get(b)! - kindCounts.get(a)!) || a.localeCompare(b)),
    [kindCounts],
  );

  const query = q.trim().toLowerCase();

  // Semantic mode (P-011): rank rows by the backend's hybrid search
  // relevance instead of substring match. Debounced; rides the existing
  // /api/user/search endpoint (same path as memory:search).
  useEffect(() => {
    if (!semantic || !query) { setSemHits(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/user/search?q=${encodeURIComponent(query)}&limit=20`);
          if (!r.ok || cancelled) return;
          const j = await r.json();
          const m = new Map<string, number>();
          for (const h of j.memories ?? []) {
            m.set(h.id as string, typeof h.score === 'number' ? h.score : 0);
          }
          if (!cancelled) setSemHits(m);
        } catch { /* leave previous hits */ }
      })();
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [semantic, query]);

  const filtered = useMemo(() => {
    let out = rows.filter((r) => {
      if (filter !== 'all' && (r.kind ?? 'untagged') !== filter) return false;
      if (flaggedOnly && !isFlagged(r)) return false;
      return true;
    });
    if (query) {
      if (semantic && semHits) {
        out = out
          .filter((r) => semHits.has(r.id))
          .sort((a, b) => (semHits.get(b.id) ?? 0) - (semHits.get(a.id) ?? 0));
      } else {
        out = out.filter((r) => {
          const desc = String((r.metadata as Record<string, unknown> | undefined)?.description ?? '');
          return `${r.id}\n${desc}\n${r.text}`.toLowerCase().includes(query);
        });
      }
    }
    return out;
  }, [rows, filter, flaggedOnly, query, semantic, semHits]);
  const flaggedCount = useMemo(() => rows.filter(isFlagged).length, [rows]);
  const originCounts = useMemo(() => {
    const c: Record<MemoryOrigin, number> = { you: 0, recovered: 0, agent: 0 };
    for (const r of rows) c[originOf(r)] += 1;
    return c;
  }, [rows]);
  // EI-10371: rows the write paths flagged as credential-shaped.
  const secretCount = useMemo(
    () => rows.filter((r) => possibleSecretClasses(r) !== null).length,
    [rows],
  );

  const onAddSave = useCallback(async () => {
    const text = draftText.trim();
    if (!text) return;
    setDraftSaving(true);
    try {
      const r = await fetch('/api/user/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          kind: draftKind.trim() || undefined,
          harness_slug: draftScope || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast.success('Memory saved');
        setDraftText('');
        void setAddOpen(false);
        void refreshMeta();
      } else if (j.journaled) {
        // WI-4208: the memory store is down/saturated, but the fact is parked in
        // the write journal and replays automatically — it is SAVED, just not
        // searchable yet. Reporting "failed" here would push the user to retype
        // it (a duplicate once the drain lands) or assume it was lost.
        toast.success('Saved — finishing indexing once the memory store recovers');
        setDraftText('');
        void setAddOpen(false);
        void refreshMeta();
      } else {
        toast.error(`Save failed: ${j.error ?? r.status}`);
      }
    } finally {
      setDraftSaving(false);
    }
  }, [draftText, draftKind, draftScope, setAddOpen, refreshMeta]);

  const renderRow = useCallback((row: MemoryRow): ReactElement => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const origin = originOf(row);
    const secretClasses = possibleSecretClasses(row);
    const kind = row.kind ?? 'untagged';
    const color = MEMORY_KIND_COLOR[kind] ?? MEMORY_KIND_FALLBACK;
    const state = row.audit?.state ?? 'active';
    const stateBadge = STATE_BADGES[state];
    const brokenAnchors = row.audit?.broken_anchors ?? [];
    const description = typeof meta.description === 'string' ? meta.description : null;
    const rowDate = row.updated_at ?? row.created_at ?? null;
    const semScore = semHits?.get(row.id);
    const expanded = expandedId === row.id;
    const collapsible = row.text.length > COLLAPSE_OVER;
    const bodyText = collapsible && !expanded
      ? `${row.text.slice(0, COLLAPSED_PREVIEW).trimEnd()}…`
      : row.text;
    return (
      <li
        key={row.id}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          padding: 12, gap: 12,
          borderRadius: 6,
          border: state !== 'active' ? '1px solid var(--warn-border)' : '1px solid var(--border)',
          background: 'var(--bg-2)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ padding: '2px 8px', borderRadius: 4, background: color, color: '#fff', fontSize: 11, fontWeight: 600 }}>{kind}</span>
            {stateBadge && state !== 'active' && (
              <span
                title={brokenAnchors.length > 0
                  ? `Broken anchors:\n${brokenAnchors.map((a) => `• ${a.kind}:${a.value}${a.reason ? ` (${a.reason})` : ''}`).join('\n')}`
                  : `State: ${state}`}
                style={{
                  padding: '2px 8px', borderRadius: 4,
                  background: stateBadge.bg, color: stateBadge.color,
                  fontSize: 11, fontWeight: 600,
                  cursor: brokenAnchors.length > 0 ? 'help' : 'default',
                }}
              >
                {stateBadge.icon} {stateBadge.label}
              </span>
            )}
            {/* P-007 provenance: this fact arrived late via the write-ahead
                journal drain / transcript miner, not a live write. */}
            {typeof meta.recovered_from === 'string' && (
              <span
                title={`Recovered via ${meta.recovered_from} after an embedder outage`}
                style={{
                  padding: '2px 8px', borderRadius: 4,
                  background: 'color-mix(in srgb, var(--accent), transparent 85%)',
                  color: 'var(--accent)', fontSize: 11, fontWeight: 600,
                }}
              >
                ↻ recovered
              </span>
            )}
            {/* EI-10363 origin chip — 'recovered' rows already carry the ↻ badge above. */}
            {origin === 'you' && (
              <span
                title="You added this yourself on this settings page"
                style={{
                  padding: '2px 8px', borderRadius: 4,
                  background: 'color-mix(in srgb, var(--good), transparent 85%)',
                  color: 'var(--good)', fontSize: 11, fontWeight: 600,
                }}
              >
                ✎ you
              </span>
            )}
            {origin === 'agent' && (() => {
              // EI-10358: per-session attribution when the write was stamped
              // with it (role + session id) — falls back to the generic
              // "no source stamp" title for rows written before this landed.
              const detail = agentSourceDetailOf(row);
              const label = detail.role ? `agent · ${detail.role}` : 'agent';
              const title = detail.role
                ? `Learned from ${detail.role}${detail.session ? ` (session ${detail.session})` : ''}`
                : 'Written by an agent session — or stored before origin stamping (no source stamp on the row)';
              return (
                <span
                  title={title}
                  style={{
                    padding: '2px 8px', borderRadius: 4,
                    background: 'var(--bg-3)', color: 'var(--fg-mute)',
                    fontSize: 11, fontWeight: 600,
                  }}
                >
                  {label}
                </span>
              );
            })()}
            {/* EI-10371 stage-1 chip: write-time credential flag (detection only —
                the text is stored unchanged; the chip's job is to get a look). */}
            {secretClasses && (
              <span
                title={possibleSecretTitle(secretClasses)}
                style={{
                  padding: '2px 8px', borderRadius: 4,
                  background: 'color-mix(in srgb, var(--warn), transparent 85%)',
                  color: 'var(--warn)', fontSize: 11, fontWeight: 600, cursor: 'help',
                }}
              >
                ⚠ may contain a credential
              </span>
            )}
            {rowDate && (
              <span title={new Date(rowDate).toLocaleString()} style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                {timeAgo(rowDate)}
              </span>
            )}
            {semScore !== undefined && (
              <span title="Semantic relevance to your search" style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--bg-3)', fontSize: 11, fontWeight: 600 }}>
                {Math.round(semScore * 100)}% match
              </span>
            )}
            {meta.expires_at !== undefined && (
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>expires {new Date(meta.expires_at as string).toLocaleString()}</span>
            )}
            {row.audit?.last_validated_at && (
              <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                audited {new Date(row.audit.last_validated_at).toLocaleString()}
              </span>
            )}
          </div>
          {brokenAnchors.length > 0 && (
            <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--warn)' }}>
              {brokenAnchors.map((a, i) => (
                <div key={`${a.kind}-${a.value}-${i}`}>
                  <code style={{ background: 'transparent', color: 'var(--warn)' }}>{a.kind}:{a.value}</code>
                  {a.reason && <> — {a.reason}</>}
                </div>
              ))}
            </div>
          )}
          {editingId === row.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={editingDraft}
                onChange={(e) => setEditingDraft(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: 6, fontFamily: 'inherit', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--fg)' }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => onSaveEdit(row.id)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', fontSize: 12 }}>Save</button>
                <button type="button" onClick={() => setEditingId(null)} style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {description && (
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{description}</div>
              )}
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {bodyText}
                {collapsible && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => void setExpandedId(expanded ? null : row.id)}
                      style={{ border: 'none', background: 'transparent', color: 'var(--fg-mute)', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
                    >
                      {expanded ? 'show less' : 'show more'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setEditingId(row.id);
              setEditingDraft(row.text);
            }}
            disabled={editingId !== null && editingId !== row.id}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer' }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(row.id)}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--bad)', color: 'var(--bad)', cursor: 'pointer' }}
          >
            Delete
          </button>
        </div>
      </li>
    );
  }, [editingId, editingDraft, onSaveEdit, onDelete, expandedId, setExpandedId, semHits]);

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;

  // WI-5030: the envelope fetch failed or timed out. Say so, and offer a retry
  // — the page previously had no way to express this and just spun.
  if (metaError) {
    return (
      <div style={{ padding: 32, display: 'grid', gap: 12, justifyItems: 'start' }}>
        <div style={{ fontWeight: 600 }}>Couldn’t load your memory settings</div>
        <div style={{ opacity: 0.8 }}>{metaError}</div>
        <button onClick={() => { setMetaLoaded(false); void refreshMeta(); }}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 32, maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {confirmEl}
      <header>
        <h1>Papercusp memory</h1>
        <p className="pc-settings-intro">
          Everything Papercusp remembers, organized by who can see it.
          Personal entries are private to you; per-{t('pot', { lower: true })} entries are
          shared with anyone working on that project; the deprecated
          workspace tier is shown only if you have legacy entries to
          clean up. Edits and deletes are recorded as feedback for
          future tuning.
        </p>
        {feedbackStats && (feedbackStats.total_edits > 0 || feedbackStats.total_deletes > 0) && (
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '8px 0 0' }}>
            Lifetime feedback: <strong>{feedbackStats.total_edits}</strong> edits, <strong>{feedbackStats.total_deletes}</strong> deletes
          </p>
        )}
        {learningInstructions && (
          <Collapsible.Root style={{ marginTop: 12, padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)' }}>
            <Collapsible.Trigger style={{ width: '100%', background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontSize: 13, color: 'var(--fg-mute)', fontFamily: 'inherit' }}>
              Active extraction-prompt adaptation (from your feedback)
            </Collapsible.Trigger>
            <Collapsible.Content>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, marginTop: 8, color: 'var(--fg)' }}>
                {learningInstructions}
              </pre>
            </Collapsible.Content>
          </Collapsible.Root>
        )}
      </header>

      {/* Write-ahead journal surfacing (memory-write-journal-auto-recovery
          P-006): facts parked during an embedder outage + recoveries. */}
      {journal && journal.pending > 0 && (
        <div style={{ padding: '8px 12px', border: '1px solid var(--warn)', borderRadius: 6, background: 'var(--warn-bg)', fontSize: 13 }}>
          ⏳ <strong>{journal.pending}</strong> memor{journal.pending === 1 ? 'y is' : 'ies are'} pending embedding —
          parked safely during an embedder outage; they will be stored automatically when it recovers.
        </div>
      )}
      {journal?.lastRecovery && (
        <div style={{ padding: '8px 12px', border: '1px solid var(--good)', borderRadius: 6, background: 'color-mix(in srgb, var(--good), transparent 85%)', fontSize: 13 }}>
          ✓ Memory recovered: <strong>{journal.lastRecovery.count}</strong> fact{journal.lastRecovery.count === 1 ? '' : 's'} from{' '}
          {new Date(journal.lastRecovery.from).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
          {' – '}
          {new Date(journal.lastRecovery.to).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}
          {' '}now searchable.
        </div>
      )}
      {journal && journal.failedPermanent > 0 && (
        <div style={{ padding: '8px 12px', border: '1px solid var(--bad)', borderRadius: 6, background: 'color-mix(in srgb, var(--bad), transparent 85%)', fontSize: 13 }}>
          ❌ <strong>{journal.failedPermanent}</strong> journaled memor{journal.failedPermanent === 1 ? 'y' : 'ies'} exhausted retries —
          the content is preserved in the journal but could not be re-stored automatically.
        </div>
      )}

      {/* EI-10355 — memory pause: the "stop remembering things about me" control.
          Deliberately prominent and always rendered (not tucked behind an
          advanced section): a privacy control the user cannot find is one they
          do not have. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: 6,
          border: `1px solid ${paused ? 'var(--warn-border)' : 'var(--border)'}`,
          background: paused ? 'var(--warn-bg)' : 'var(--bg-2)',
        }}
      >
        <div style={{ minWidth: 260, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {paused ? '⏸ Memory is paused' : 'Remembering is on'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 2 }}>
            {paused
              ? 'Nothing new is being remembered about you. Your existing memories below are untouched — you can still read, edit, delete and download them.'
              : 'Agents may store new facts about you. Pause to stop that without deleting anything.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void togglePaused(!paused)}
          disabled={pausing}
          aria-pressed={paused}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 13, whiteSpace: 'nowrap',
            cursor: pausing ? 'wait' : 'pointer',
            border: '1px solid var(--border)',
            background: paused ? 'var(--good)' : 'transparent',
            color: paused ? 'var(--bg)' : 'var(--fg)',
          }}
        >
          {pausing ? '…' : paused ? 'Resume memory' : 'Pause memory'}
        </button>
      </div>

      {/* EI-10368 — recall health: the daily live canary's latest verdict.
          Its alert leg is a transient push on the ok→degraded edge only;
          this line is the persistent answer to "is memory search actually
          working right now?". */}
      {(() => {
        const health = recallHealthLine(recallCanary);
        return (
          <div
            title="A daily read-only canary replays known memories against the live store to catch silent recall breakage (schema drift, embedder misconfig) that test suites miss."
            style={
              health.tone === 'warn'
                ? { padding: '8px 12px', border: '1px solid var(--warn-border)', borderRadius: 6, background: 'var(--warn-bg)', fontSize: 13 }
                : { fontSize: 12, color: health.tone === 'good' ? 'var(--good)' : 'var(--fg-mute)' }
            }
          >
            {health.text}
          </div>
        );
      })()}

      {availableBackends.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label htmlFor="memory-backend-select" style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
              Active store:
            </label>
            <Select
              id="memory-backend-select"
              value={currentBackend}
              disabled={switchingBackend}
              onChange={(value) => void switchBackend(value)}
              ariaLabel="Active memory store"
              triggerStyle={{ padding: '4px 8px', fontSize: 13, cursor: switchingBackend ? 'wait' : 'pointer' }}
              options={availableBackends.map((b) => ({ value: b, label: BACKEND_DOCS[b]?.label ?? b }))}
            />
          </div>

          {/* The question people actually have before switching — answered up
              front, because the honest answer ("nothing happens to your data")
              is not guessable from the option names. */}
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: 0, lineHeight: 1.5 }}>
            Every mode reads and writes the <strong>same</strong> memories, in one Postgres table.
            Switching changes only <em>how</em> a memory is found — never what is stored, so nothing
            is lost or needs re-importing, and you can switch back at any time. Applies live, no restart.
          </p>

          <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {availableBackends.map((b) => {
              const doc = BACKEND_DOCS[b];
              const active = b === currentBackend;
              return (
                <div key={b} style={{ fontSize: 12, lineHeight: 1.5 }}>
                  <dt style={{ display: 'inline', fontWeight: 600, color: active ? 'var(--fg)' : 'var(--fg-mute)' }}>
                    <code>{b}</code>
                    {active && (
                      <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--good)' }}>· in use</span>
                    )}
                  </dt>
                  {doc && (
                    <dd style={{ display: 'inline', margin: 0, color: 'var(--fg-mute)' }}> — {doc.summary}</dd>
                  )}
                </div>
              );
            })}
          </dl>
        </div>
      )}

      {reason && (
        <div style={{ padding: 12, border: '1px solid var(--warn-border)', borderRadius: 6, background: 'var(--warn-bg)' }}>
          Memory backend{backendName ? <> (<code>{backendName}</code>)</> : null} unavailable: <code>{reason}</code>.
          {reason === 'mem0_unavailable' && (
            <> Run <code>npm install</code> in <code>apps/operator</code> to enable.</>
          )}
          {reason === 'memory_backend_disabled' && (
            <> The store is deliberately off (<code>PAPERCUSP_MEMORY_BACKEND=noop</code>); flip the env var to re-enable.</>
          )}
        </div>
      )}

      {/* knowledge-pack-settings-2026-07-19 P-005 — the workspace-wide
          fleet-lessons loop knobs (cadence, adoption policy, hygiene bounds).
          Deliberately on this page (D-001): knowledge packs are fleet memory. */}
      <FleetKnowledgePacksSection />

      {/* memory-reduction-2026-09-24 P-008 — Auto / GPU / CPU for the local
          embedding models, with what they actually run on. */}
      <EmbedDeviceSection />

      {/* jev-decision-model-integration-2026-09-29 P-013 / D-008 — Off / Log only / On
          for TypeSafe's Jev in memory injection, plus the Jev API key. Off keeps
          the current system. */}
      <JevSection />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => void setQ(e.target.value || null)}
          // EI-12937: when limited, be honest that search only covers the LOADED
          // window (rows.length), not the whole corpus — "Search 300 memories…"
          // reads very differently from "Search all memories…" and a user typing
          // a query expecting full-history coverage deserves to know which they get.
          placeholder={
            possiblyMoreThanShown
              ? `Search your ${rows.length} most recent of ${totalMemories ?? '…'} memories…`
              : `Search ${rows.length} memories…`
          }
          aria-label="Search memories"
          style={{
            padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg-2)',
            color: 'var(--fg)', fontSize: 13, flex: 1,
          }}
        />
        {possiblyMoreThanShown && (
          <Tooltip label="You're viewing your most recent memories only. Load everything to search/filter your full history (bigger download).">
            <button
              type="button"
              onClick={() => void setShowAll(true)}
              style={{
                padding: '8px 12px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg-2)',
                cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
              }}
            >
              Show all
            </button>
          </Tooltip>
        )}
        {showAll && (
          <Tooltip label="Back to the fast, bounded recent-memories view.">
            <button
              type="button"
              onClick={() => void setShowAll(false)}
              style={{
                padding: '8px 12px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--bg-2)',
                cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
              }}
            >
              Show recent only
            </button>
          </Tooltip>
        )}
        <Tooltip label="Rank by semantic relevance (the same hybrid search agents use) instead of substring match."><button
          type="button"
          onClick={() => void setSemantic(!semantic)}

          style={{
            padding: '8px 12px', borderRadius: 6,
            border: semantic ? '2px solid var(--fg)' : '1px solid var(--border)',
            background: semantic ? 'var(--bg-3)' : 'var(--bg-2)',
            cursor: 'pointer', fontSize: 13, fontWeight: semantic ? 600 : 400,
            whiteSpace: 'nowrap',
          }}
        >
          ✨ semantic
        </button></Tooltip>
        <button
          type="button"
          onClick={() => void setAddOpen(!addOpen)}
          style={{
            padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--border)',
            background: addOpen ? 'var(--bg-3)' : 'var(--bg-2)',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          ＋ Add memory
        </button>
      </div>

      {addOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)' }}>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={3}
            placeholder="The fact to remember — durable, one fact per memory."
            style={{ width: '100%', padding: 8, fontFamily: 'inherit', fontSize: 13, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--fg)' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              list="memory-kind-suggestions"
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value)}
              placeholder="kind (optional)"
              aria-label="Memory kind"
              style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', color: 'var(--fg)', fontSize: 13, width: 160 }}
            />
            <datalist id="memory-kind-suggestions">
              {[...new Set([...KIND_SUGGESTIONS, ...kindChips])].map((k) => <option key={k} value={k} />)}
            </datalist>
            <Select
              value={draftScope || '_personal'}
              onChange={(value) => setDraftScope(value === '_personal' ? '' : value)}
              ariaLabel="Memory scope"
              triggerStyle={{ padding: '6px 10px', fontSize: 13 }}
              options={[
                { value: '_personal', label: 'Personal' },
                ...harnesses.map((h) => ({ value: h, label: `${t('pot', { lower: true })}: ${h}` })),
              ]}
            />
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void onAddSave()}
              disabled={draftSaving || !draftText.trim()}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: draftSaving || !draftText.trim() ? 0.5 : 1 }}
            >
              {draftSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => void setAddOpen(false)}
              style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['all', ...kindChips].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void setFilter(f)}
              style={{
                padding: '4px 10px', borderRadius: 6,
                border: filter === f ? '2px solid var(--fg)' : '1px solid var(--border)',
                background: filter === f ? 'var(--bg-3)' : 'var(--bg-2)',
                cursor: 'pointer', fontSize: 13,
                fontWeight: filter === f ? 600 : 400,
              }}
            >
              {f} {f !== 'all' && `(${kindCounts.get(f) ?? 0})`}
            </button>
          ))}
          <Tooltip label="Show only memories with broken anchors / contradictions / etc."><button
            type="button"
            onClick={() => void setFlaggedOnly(!flaggedOnly)}

            style={{
              padding: '4px 10px', borderRadius: 6,
              border: flaggedOnly ? '2px solid var(--warn)' : '1px solid var(--border)',
              background: flaggedOnly ? 'var(--warn-bg)' : 'var(--bg-2)',
              color: flaggedOnly ? 'var(--warn)' : 'var(--fg)',
              cursor: 'pointer', fontSize: 13,
              fontWeight: flaggedOnly ? 600 : 400,
            }}
          >
            ⚠ flagged only ({flaggedCount})
          </button></Tooltip>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tooltip label="Run the Layer 1 structural anchor audit — checks that every file / plan / migration referenced by a memory still exists. Free and fast."><button
            type="button"
            onClick={onAuditAll}
            disabled={auditBusy || rows.length === 0}

            style={{
              padding: '4px 10px', borderRadius: 6,
              border: '1px solid var(--border)',
              background: auditBusy ? 'var(--bg-2)' : 'var(--bg-3)',
              cursor: auditBusy ? 'wait' : 'pointer',
              fontSize: 13, fontWeight: 600,
              opacity: auditBusy ? 0.5 : 1,
            }}
          >
            {auditBusy ? 'Auditing…' : 'Audit all'}
          </button></Tooltip>
          <Tooltip label="Re-embed openai-collection memories into the local-collection so they're visible after switching memoryEmbedderMode to local."><button
            type="button"
            onClick={() => onReembed('openai', 'local')}
            disabled={reembedBusy !== null}

            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'openai-to-local' ? 'Re-embedding…' : 'openai → local'}
          </button></Tooltip>
          <Tooltip label="Re-embed local-collection memories into the openai-collection so they're visible after switching memoryEmbedderMode to openai."><button
            type="button"
            onClick={() => onReembed('local', 'openai')}
            disabled={reembedBusy !== null}

            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'local-to-openai' ? 'Re-embedding…' : 'local → openai'}
          </button></Tooltip>
          <Tooltip label="Re-embed BGE-small (local) memories into the EmbeddingGemma-300m collection so they're visible after switching your memory system to EmbeddingGemma (the default)."><button
            type="button"
            onClick={() => onReembed('local', 'gemma')}
            disabled={reembedBusy !== null}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'local-to-gemma' ? 'Re-embedding…' : 'local → gemma'}
          </button></Tooltip>
          <Tooltip label="Re-embed OpenAI memories into the EmbeddingGemma-300m collection so they're visible after switching your memory system to EmbeddingGemma (the default)."><button
            type="button"
            onClick={() => onReembed('openai', 'gemma')}
            disabled={reembedBusy !== null}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'openai-to-gemma' ? 'Re-embedding…' : 'openai → gemma'}
          </button></Tooltip>
          <Tooltip label="Re-embed EmbeddingGemma memories into the Harrier-OSS-0.6b collection so they're visible after switching your memory system to Harrier (best recall on the internal gold set; ~4× slower embeds)."><button
            type="button"
            onClick={() => onReembed('gemma', 'harrier')}
            disabled={reembedBusy !== null}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12, opacity: reembedBusy ? 0.5 : 1 }}
          >
            {reembedBusy === 'gemma-to-harrier' ? 'Re-embedding…' : 'gemma → harrier'}
          </button></Tooltip>
          <Tooltip label="Download all of your personal memories as a JSON file (data portability). Workspace-shared entries are not included."><button
            type="button"
            onClick={() => { window.location.href = '/api/user/memory/export'; }}
            disabled={rows.length === 0}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 13, opacity: rows.length === 0 ? 0.5 : 1 }}
          >
            Download my memories
          </button></Tooltip>
          <button
            type="button"
            onClick={onForgetAll}
            disabled={rows.length === 0}
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bad)', color: 'var(--bad)', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
          >
            Forget all my memories
          </button>
        </div>
      </div>

      {/* EI-10363: coarse origin breakdown — where these memories came from,
          derived client-side from the stamps the rows already carry. */}
      {rows.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
          Origins: <strong>{originCounts.you}</strong> added by you
          {' · '}<strong>{originCounts.recovered}</strong> recovered
          {' · '}<strong>{originCounts.agent}</strong> from agent sessions
        </div>
      )}

      {/* EI-10371: write-time credential flags — the persistent surface that
          gets flagged rows LOOKED AT (the chip alone is easy to scroll past). */}
      {secretCount > 0 && (
        <div style={{ fontSize: 12, color: 'var(--warn)' }}>
          ⚠ <strong>{secretCount}</strong> {secretCount === 1 ? 'memory looks like it contains' : 'memories look like they contain'} a
          credential — stored unchanged, flagged at write time. If real, rotate the secret, then edit or delete the row.
        </div>
      )}

      {/* The denominator (WI-39540). Rendered whenever the corpus is larger
          than the loaded window, so the row count on screen can never be
          mistaken for the size of the corpus. */}
      {showDenominator && (
        <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
          Showing <strong>{rows.length}</strong> of <strong>{totalMemories}</strong> memories
          {' — '}scroll for more{showAll ? '' : ', or load them all at once with “Show all”'}.
        </div>
      )}

      {(() => {
        const userRows = filtered.filter((r) => r.scope === 'user');
        const harnessRows = filtered.filter((r) => r.scope === 'harness');
        const workspaceRows = filtered.filter((r) => r.scope === 'workspace');

        if (filtered.length === 0) {
          return (
            <p style={{ color: 'var(--fg-mute)' }}>
              {rows.length === 0
                ? 'No memories stored yet.'
                : query
                  ? `No memories matching “${q.trim()}”.`
                  : `No memories matching '${filter}'.`}
            </p>
          );
        }

        // Group harness rows by slug
        const bySlug = new Map<string, MemoryRow[]>();
        for (const r of harnessRows) {
          const slug = r.harness_slug ?? (r.metadata as Record<string, unknown> | undefined)?.harness_slug as string ?? 'unknown';
          if (!bySlug.has(slug)) bySlug.set(slug, []);
          bySlug.get(slug)!.push(r);
        }

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Section
              title="My memory"
              description="Personal facts about you. Private — only you see these. Carried across every project."
              rows={userRows}
              renderRow={renderRow}
              empty="No personal memories yet. Tell Papercusp something to remember — &ldquo;remember I prefer terse replies&rdquo; — and it&rsquo;ll land here."
            />
            <Section
              title={`Per-${t('pot')} memory`}
              description={`Project-specific facts shared with anyone who has access to that ${t('pot', { lower: true })}. Use these for team conventions, project context, or anything an agent working on this project should know.`}
              rows={harnessRows}
              renderRow={renderRow}
              groupedBySlug={bySlug}
              empty={`No per-${t('pot', { lower: true })} memories yet. Ask Papercusp to remember a project fact and tag a ${t('pot', { lower: true })} — “for the sheets ${t('pot', { lower: true })}, we use BigQuery”.`}
            />
            {workspaceRows.length > 0 && (
              <Section
                title="Deprecated — workspace memory"
                description={`Older shared memories from before per-${t('pot', { lower: true })} scope existed. Move important ones into the right ${t('pot', { lower: true })} (delete here, then ask Papercusp to remember with a harness_slug), or just delete.`}
                rows={workspaceRows}
                renderRow={renderRow}
                deprecated
              />
            )}
          </div>
        );
      })()}

      {/* Infinite-scroll sentinel (WI-39540). Rendered only while more rows
          exist, so the observer in the effect above has nothing to watch once
          the corpus is fully loaded. */}
      {hasMore && (
        <div
          ref={loadMoreRef}
          data-testid="memory-load-more-sentinel"
          style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--fg-mute)' }}
        >
          {rowsLoading
            ? 'Loading more memories…'
            : `Scroll for more — ${remaining === null ? 'more' : remaining} remaining`}
        </div>
      )}
    </div>
  );
}

function Section(props: {
  title: string;
  description: string;
  rows: MemoryRow[];
  renderRow: (row: MemoryRow) => ReactElement;
  empty?: string;
  groupedBySlug?: Map<string, MemoryRow[]>;
  deprecated?: boolean;
}) {
  const { title, description, rows, renderRow, empty, groupedBySlug, deprecated } = props;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, opacity: deprecated ? 0.7 : 1 }}>{title}</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-mute)' }}>{description}</p>
      </div>
      {rows.length === 0 ? (
        empty ? <p style={{ color: 'var(--fg-mute)', fontSize: 13, fontStyle: 'italic', margin: 0 }}>{empty}</p> : null
      ) : groupedBySlug ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[...groupedBySlug.entries()].map(([slug, slugRows]) => (
            <div key={slug} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 13, color: 'var(--fg-mute)', textTransform: 'uppercase' }}>{slug}</h3>
              <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {slugRows.map(renderRow)}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(renderRow)}
        </ul>
      )}
    </section>
  );
}
