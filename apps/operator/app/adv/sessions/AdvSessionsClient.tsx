'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { CompanionListSummary } from '@papercusp/facets';
import { readListMeta } from '@papercusp/operator-core/lib/sync-resolver/list-meta';
import {
  type AdvSessionFacetMeta,
} from '@papercusp/operator-core/lib/sync-resolver/adv-sessions-list-query';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Tabs from '@radix-ui/react-tabs';
import { ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { parseAsArrayOf, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Combobox } from '@/app/harness/Combobox';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { filterCountLabel, type CountEvidence } from '@/app/harness/filters';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
import { useLexicon } from '@/lib/useLexicon';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { usePlanList, type PlanListRow } from '../../admin/plans/plans-api';
import {
  buildLaunchPlanOptions,
  MODEL_SELECT_DEFAULT,
  OMP_MODEL_OPTIONS,
  PLAN_SELECT_PLACEHOLDER,
} from './NewSessionLauncher';
import {
  mergeAdvSessionPage,
  sessionHarnessOptions as buildSessionHarnessOptions,
  sessionHistoryEvidence,
  sessionPlanStats,
} from './sessions-history-model';

export { mergeAdvSessionPage } from './sessions-history-model';

interface ServerRowSummary {
  ompSessionId: string;
  userMessages: number;
  latestModel: string | null;
  totalTokens: number;
  totalCostUsd: number;
}

export interface SessionRow {
  id: number;
  workspaceId: string;
  harnessSlug?: string | null;
  planSlug: string | null;
  /** Which agent CLI backs this session (psu-launched rows); null for
   *  legacy/pre-*-su rows. More specific than `mode`. */
  agent: 'claude' | 'omp' | 'codex' | null;
  /** Pipeline role this session runs as (psu --role); null = plain SU/engineer. */
  role: string | null;
  /** Feature the role session is scoped to; null when none. */
  feature: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  /** Server-computed lightweight summary for OMP rows; null for
   *  console rows or for OMP rows whose JSONL isn't loadable yet
   *  (brand-new launches still initializing). */
  summary: ServerRowSummary | null;
  /** true ⇒ this session has a live OS window on screen right now (derived
   *  server-side via wmctrl) — and is hard-exempt from the idle-session reaper. */
  onDesktop?: boolean;
}

interface OmpSessionMatch {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  title: string;
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  timeDriftMs: number;
}

interface OmpMessageSnippet {
  id?: string;
  timestamp?: string;
  role: string;
  toolName?: string;
  isError?: boolean;
  text: string;
}

interface OmpTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'abandoned';
  notes?: string[];
}

interface OmpTodoPhase {
  name: string;
  tasks: OmpTodoItem[];
}

interface OmpToolSummary {
  toolName: string;
  calls: number;
  results: number;
  errors: number;
  lastUsedAt?: string;
}

interface OmpSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  assistantTurnsWithUsage: number;
}

interface OmpSessionState {
  header: {
    id: string;
    cwd: string;
    timestamp: string;
    title?: string;
  };
  filePath: string;
  totalLines: number;
  countsByType: Record<string, number>;
  messages: {
    total: number;
    user: number;
    assistant: number;
    toolResults: number;
  };
  /** Optional — older API responses (pre-token-spend) omit these. */
  models?: string[];
  latestModel?: string | null;
  usage?: OmpSessionUsage;
  latestMessages: OmpMessageSnippet[];
  todos: OmpTodoPhase[];
  toolCounts: OmpToolSummary[];
  jobs: OmpMessageSnippet[];
  goals: OmpMessageSnippet[];
  compactions: OmpMessageSnippet[];
  handoffs: OmpMessageSnippet[];
}

const EMPTY_USAGE: OmpSessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  assistantTurnsWithUsage: 0,
};

/** Always returns a populated usage block — missing fields default
 *  to 0 so the UI never tries to read `.totalTokens` off undefined. */
function normalizeUsage(u: OmpSessionUsage | undefined): OmpSessionUsage {
  if (!u) return EMPTY_USAGE;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    totalCostUsd: u.totalCostUsd ?? 0,
    assistantTurnsWithUsage: u.assistantTurnsWithUsage ?? 0,
  };
}

interface OmpMemoryState {
  ok?: boolean;
  backend?: unknown;
  hindsight?: {
    apiUrl?: unknown;
    scoping?: unknown;
    autoRecall?: unknown;
    autoRetain?: unknown;
    retainMode?: unknown;
    recallBudget?: unknown;
    recallMaxTokens?: unknown;
  };
  error?: string;
}

interface SessionStateResponse {
  ok: boolean;
  advSession: SessionRow | null;
  match: OmpSessionMatch | null;
  state: OmpSessionState | null;
  memory: OmpMemoryState;
  error: string | null;
}

interface SessionSearchMatch {
  session: {
    id: string;
    title: string;
    cwd: string;
    timestamp: string;
  };
  line: number;
  entryId?: string;
  timestamp?: string;
  type: string;
  role?: string;
  toolName?: string;
  snippet: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface SessionSearchResponse {
  ok: boolean;
  query: string;
  matches: SessionSearchMatch[];
  truncated: boolean;
  searchedSessions: number;
  error?: string | null;
}

type SessionPanel = 'overview' | 'context' | 'history' | 'todos' | 'jobs' | 'goal' | 'tools' | 'memory' | 'handoff';

const SESSION_PANELS: Array<{ value: SessionPanel; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'context', label: 'Context' },
  { value: 'history', label: 'History' },
  { value: 'todos', label: 'Todos' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'goal', label: 'Goal' },
  { value: 'tools', label: 'Tools' },
  { value: 'memory', label: 'Memory' },
  { value: 'handoff', label: 'Handoff' },
];

/** Agents the "Launch SU" button can spawn (via the psu launcher). */
const SU_AGENT_OPTIONS = [
  { value: 'claude', label: 'claude' },
  { value: 'omp', label: 'omp' },
  { value: 'codex', label: 'codex' },
];

// Agent launch context is trimmed-only. 'default' omits the flag for backward
// compatibility with existing links; an explicit choice selects the growable
// trimmed seed (small core up front, the rest reached on demand).
//
// SU_CONTEXT_TOKEN_ESTIMATES — the per-variant ~Nk figures shown in the picker.
// STATIC by deliberate choice (WI-1282): these are MEASURED estimates —
//   trimmed ≈ ~70k — re-measured 2026-07-02 after the Phase-3 cuts (fleet persona
//   tier, P-020 plugin prune, P-015 zero-AGENTS.md): 60.1k sonnet fleet boot /
//   ~66k fable fleet / ~76k full-persona power launch. The P-018 '~83k' was
//   measured pre-Phase-3 with the full persona.
// They are NOT computed live: js-tiktoken is a dep but there is no server seam
// that serializes the full-vs-core-filtered tools/list catalog for tokenizing,
// and the headline totals fold in the system-prompt prefix (not catalog-
// derived). Wire these to a real /api token-count endpoint if/when that catalog
// seam lands; until then this + psu-launcher.mjs's twin are the places to update.
const SU_CONTEXT_TOKEN_ESTIMATES = {
  trimmed: '~70k',
} as const;
const CONTEXT_SELECT_DEFAULT = '__default_context__';
const SU_CONTEXT_OPTIONS = [
  { value: CONTEXT_SELECT_DEFAULT, label: 'Context: default' },
  { value: 'trimmed', label: `Trimmed · ${SU_CONTEXT_TOKEN_ESTIMATES.trimmed}` },
];

const SESSION_HISTORY_PAGE = 100;

export default function AdvSessionsClient() {
  const t = useLexicon();
  const [aliveByPid, setAliveByPid] = useState<Record<number, boolean>>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [launchPlanSlug, setLaunchPlanSlug] = useQueryState('newPlan', parseAsString);
  const [launchModel, setLaunchModel] = useQueryState(
    'model',
    parseAsString.withDefault(''),
  );
  const [selectedSessionId, setSelectedSessionId] = useQueryState('session', parseAsString);
  // Plan groups start collapsed; user-expanded ones are pinned in the
  // URL. nuqs so reloads keep the user's open set.
  const [expandedGroups, setExpandedGroups] = useQueryState(
    'expand',
    parseAsArrayOf(parseAsString).withDefault([]),
  );
  const [panel, setPanel] = useQueryState('panel', parseAsString.withDefault('overview'));
  const [historyQuery, setHistoryQuery] = useQueryState('q', parseAsString.withDefault(''));
  const [launchingNew, setLaunchingNew] = useState(false);
  const [suAgent, setSuAgent] = useQueryState(
    'suAgent',
    parseAsStringEnum<'claude' | 'omp' | 'codex'>(['claude', 'omp', 'codex']).withDefault('claude'),
  );
  // null ⇒ legacy/native default (no flag); the only explicit public choice is trimmed.
  const [suContext, setSuContext] = useQueryState(
    'suContext',
    parseAsStringEnum<'trimmed'>(['trimmed']),
  );
  const [launchingSu, setLaunchingSu] = useState(false);
  const [stateData, setStateData] = useState<SessionStateResponse | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [searchData, setSearchData] = useState<SessionSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [sessionHarnessFilter, setSessionHarnessFilter] = useQueryState('h', parseAsString);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [loadedSessions, setLoadedSessions] = useState<SessionRow[]>([]);
  const [nextSessionCursor, setNextSessionCursor] = useState<string | null>(null);
  const [sessionPageReady, setSessionPageReady] = useState(false);
  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const sessionsQuery = useSyncQuery<SessionRow>({
    queryName: 'advSessions.list',
    args: {
      limit: SESSION_HISTORY_PAGE,
      ...(sessionHarnessFilter ? { harnessSlugs: [sessionHarnessFilter] } : {}),
      ...(sessionCursor ? { cursor: sessionCursor } : {}),
    },
  });
  const sessionsSummaryQuery = useSyncQuery<CompanionListSummary<AdvSessionFacetMeta>>({
    queryName: 'advSessions.summary',
    args: sessionHarnessFilter ? { harnessSlugs: [sessionHarnessFilter] } : {},
  });
  const summary = sessionsSummaryQuery.data?.[0] ?? null;
  const errorValue = sessionsQuery.error ?? sessionsSummaryQuery.error;
  const error = errorValue ? String(errorValue) : null;

  useEffect(() => {
    setSessionCursor(null);
    setLoadedSessions([]);
    setNextSessionCursor(null);
    setSessionPageReady(false);
  }, [sessionHarnessFilter]);

  useEffect(() => {
    if (sessionsQuery.loading || sessionsQuery.fetching || !sessionsQuery.data) return;
    setLoadedSessions((previous) =>
      mergeAdvSessionPage(previous, sessionsQuery.data!, sessionCursor),
    );
    const meta = readListMeta(sessionsQuery.data);
    setNextSessionCursor(
      typeof meta?.nextCursor === 'string' ? meta.nextCursor : null,
    );
    setSessionPageReady(true);
  }, [sessionsQuery.data, sessionsQuery.loading, sessionsQuery.fetching, sessionCursor]);

  const rows = sessionPageReady ? loadedSessions : null;
  const pairedFetching = Boolean(
    sessionsQuery.loading ||
    sessionsQuery.fetching ||
    sessionsSummaryQuery.loading ||
    sessionsSummaryQuery.fetching
  );
  const countEvidence = useMemo(
    () => sessionHistoryEvidence({
      error: Boolean(error),
      updating: pairedFetching,
      loadedCount: rows?.length ?? null,
      summary,
    }),
    [error, pairedFetching, rows?.length, summary],
  );
  const loadedCountEvidence = countEvidence.loaded;
  const matchedCountEvidence = countEvidence.matched;
  const loadedCountLabel = useMemo(
    () => filterCountLabel(loadedCountEvidence, 'session'),
    [loadedCountEvidence],
  );
  const matchedCountLabel = useMemo(
    () => filterCountLabel(matchedCountEvidence, 'session'),
    [matchedCountEvidence],
  );
  const exactPlanStats = useMemo(() => sessionPlanStats(summary), [summary]);

  const activePanel = isSessionPanel(panel) ? panel : 'overview';

  useEffect(() => {
    if (refreshTick > 0) {
      setSessionCursor(null);
      setLoadedSessions([]);
      setNextSessionCursor(null);
      setSessionPageReady(false);
      sessionsQuery.invalidate?.();
      sessionsSummaryQuery.invalidate?.();
    }
    // refreshTick is the explicit user/action invalidation signal; the query
    // object identity is intentionally omitted to avoid repeated invalidates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // Lazy-load token/cost/model summary for each OMP row so the main
  // Row-summary fields (model, tokens, cost, user-message count,
  // OMP session id) now arrive pre-computed on each OMP row via
  // /api/adv/sessions.row.summary. No client-side lazy fetching — the
  // first paint of the list is already final, so the user never sees
  // rows flash in and then disappear as summaries resolve.

  // Re-check pid liveness when the row list changes. For rows the DB
  // says are still active, ask the operator whether the pid is alive —
  // child-exit listener can miss exits across operator restarts.
  useEffect(() => {
    if (!rows) return;
    const activeWithPid = rows.filter((r) => r.endedAt == null && r.pid != null);
    if (activeWithPid.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<number, boolean> = {};
      for (const row of activeWithPid) {
        try {
          const r = await fetch(`/api/adv/sessions/alive?pid=${row.pid}`);
          if (!r.ok) continue;
          const data = (await r.json()) as { alive: boolean };
          updates[row.pid!] = data.alive;
        } catch { /* swallow */ }
      }
      if (!cancelled) setAliveByPid((prev) => ({ ...prev, ...updates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const selectedRow = useMemo(() => {
    if (!rows || !selectedSessionId) return null;
    const id = Number(selectedSessionId);
    if (!Number.isFinite(id)) return null;
    return rows.find((row) => row.id === id) ?? null;
  }, [rows, selectedSessionId]);

  // Deliberately depend on selectedRow?.id (the stable identity) and
  // refreshTick (explicit user action) — NOT the full selectedRow
  // object. The 3s auto-refresh rebuilds the rows array every cycle;
  // selectedRow is a useMemo over rows so it gets a new reference on
  // every poll even when the underlying row didn't change. Depending
  // on the object made this effect re-run every 3s and flash a fresh
  // "Loading session state…" placeholder, which is exactly the
  // flicker the user reported.
  const selectedRowId = selectedRow?.id ?? null;
  useEffect(() => {
    if (selectedRowId === null) {
      setStateData(null);
      setStateError(null);
      setSearchData(null);
      return;
    }
    let cancelled = false;
    setStateLoading(true);
    setStateError(null);
    (async () => {
      try {
        const r = await fetch(`/api/adv/sessions/state?id=${selectedRowId}`, {
          headers: { accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SessionStateResponse;
        if (!cancelled) setStateData(data);
      } catch (e: unknown) {
        if (!cancelled) {
          setStateError(e instanceof Error ? e.message : String(e));
          setStateData(null);
        }
      } finally {
        if (!cancelled) setStateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRowId, refreshTick]);

  useEffect(() => {
    const q = historyQuery.trim();
    if (!selectedRow || activePanel !== 'history' || q.length === 0) {
      setSearchData(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ id: String(selectedRow.id), q, limit: '50' });
        const r = await fetch(`/api/adv/sessions/search?${params.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SessionSearchResponse;
        if (!cancelled) setSearchData(data);
      } catch (e: unknown) {
        if (!cancelled) {
          setSearchData({
            ok: false,
            query: q,
            matches: [],
            truncated: false,
            searchedSessions: 0,
          });
          toast.error(`Session search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePanel, historyQuery, selectedRow]);

  // WI-1675 (D-002 part 2): push the Session-1 desktop window list to the
  // operator so its Windows liveness reaper can exempt on-desktop sessions. The
  // operator runs inside the WSL2 distro (Session 0) and CANNOT enumerate the
  // interactive desktop; this renderer runs IN the Tauri shell (Session 1) and
  // can, via the native `list_windows_by_title` Rust command. No-op off the
  // Tauri desktop shell; off Windows the command returns [] (a harmless empty
  // push). We filter to the `Papercup — ` prefix client-side so the operator
  // only ever sees Papercup session terminals, never the user's other windows.
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) {
      return;
    }
    const PAPERCUP_WINDOW_PREFIX = 'Papercup — '; // 'Papercup — ' (em dash)
    let cancelled = false;
    const push = async () => {
      try {
        const windows = await invoke<{ title: string; pid: number; hwnd: string }[]>(
          'list_windows_by_title',
          { prefix: PAPERCUP_WINDOW_PREFIX },
        );
        if (cancelled) return;
        await fetch('/api/adv/on-desktop-windows', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ windows }),
        }).catch(() => {});
      } catch {
        // command absent (older shell / non-Windows) / invoke unavailable → skip.
      }
    };
    void push(); // seed immediately so the reaper isn't blind for the first interval
    const timer = setInterval(() => void push(), 20_000);
    const onFocus = () => void push();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const isActive = useCallback(
    (row: SessionRow): boolean => {
      if (row.endedAt != null) return false;
      if (row.pid == null) return false;
      // Default to "active" until the liveness check returns false.
      return aliveByPid[row.pid] !== false;
    },
    [aliveByPid],
  );

  const selectedLaunchPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === launchPlanSlug) ?? null,
    [launchPlanSlug, planList.data],
  );
  // P-026: grouped + sorted picker. Plans group by `harness` (their
  // resolved harness slug); within each group sort by `updated` DESC;
  // labels gain "· updated Nd ago" for context. The AdvShell-active
  // harness slug is read from the `slug` nuqs key (we don't import
  // AdvShell directly to avoid a cycle) so its group leads. Empty
  // groups are omitted.
  const [advActiveSlug] = useQueryState('slug', parseAsString);
  const launchPlanOptions = useMemo(
    () => buildLaunchPlanOptions(planList.data?.plans ?? [], advActiveSlug, planList.loading, `(no ${t('pot', { lower: true })})`),
    [planList.data, planList.loading, advActiveSlug, t],
  );


  const launchNewSession = useCallback(async () => {
    if (!selectedLaunchPlan) {
      toast.error('Choose a plan before launching a session.');
      return;
    }
    if (launchingNew) return;
    setLaunchingNew(true);
    try {
      const model = launchModel.trim();
      const label = selectedLaunchPlan.title?.trim() || selectedLaunchPlan.slug;
      const result = await launchAgent({
        slug: null,
        planSlug: selectedLaunchPlan.slug,
        label,
        model: model || null,
      });
      if (result.ok) {
        toast.success(
          `Agent launched for ${label}${model ? ` (${model})` : ''}.`,
          { duration: 3000 },
        );
        setRefreshTick((t) => t + 1);
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunchingNew(false);
    }
  }, [launchModel, launchingNew, selectedLaunchPlan]);

  // P-020: in-app "Launch SU" — server-spawns a terminal running
  // `psu --no-picker …` for the chosen agent in the active harness, with
  // the selected plan (or no plan). psu records the tracked adv_sessions
  // row; it appears in the list via the live poll.
  const launchSu = useCallback(async () => {
    if (launchingSu) return;
    setLaunchingSu(true);
    try {
      const r = await fetch('/api/adv/sessions/launch-su', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: suAgent,
          harness_slug: advActiveSlug ?? null,
          plan_slug: launchPlanSlug ?? null,
          context_size: suContext ?? null,
        }),
      });
      const data = (await r.json()) as { status?: string; code?: string; error?: string };
      if (data.status === 'ok') {
        toast.success(
          `Launched ${suAgent}-su${launchPlanSlug ? ` for ${launchPlanSlug}` : ' (no plan)'} — it will appear in Sessions shortly.`,
        );
        window.setTimeout(() => setRefreshTick((t) => t + 1), 1500);
      } else if (data.code === 'psu_not_installed') {
        toast.error(data.error ?? 'psu is not installed.');
      } else {
        toast.error(`Launch failed: ${data.error ?? 'unknown error'}`);
      }
    } catch (e) {
      toast.error(`Launch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaunchingSu(false);
    }
  }, [launchingSu, suAgent, suContext, advActiveSlug, launchPlanSlug]);

  const focusRow = useCallback(async (row: SessionRow) => {
    if (!row.pid && !row.windowId) {
      toast.error('No pid or window id recorded for this session — cannot focus.');
      return;
    }
    // Windows desktop (windows-desktop-feature-parity D-002): the operator runs
    // inside the WSL2 distro (Session 0) and CANNOT focus a Session-1 desktop
    // window. The renderer runs IN the Tauri shell (Session 1), so it invokes
    // the native Rust `focus_window_by_title` command directly. On Windows
    // `row.windowId` IS the exact window title (console-record stores
    // `Papercup — <sessionId>` as the windowId). The command returns false on a
    // non-Windows operator, so a Linux desktop falls through to the wmctrl POST
    // below. This is a click → user-initiated (feedback_e2e_no_focus_steal).
    if (
      row.windowId &&
      typeof window !== 'undefined' &&
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) {
      try {
        const focused = await invoke<boolean>('focus_window_by_title', { title: row.windowId });
        if (focused) {
          toast.success('Window focused.', { duration: 2000 });
          return;
        }
        // false → not a Windows desktop (or no title match) → fall through to
        // the operator-side (wmctrl) focus path.
      } catch {
        // command absent (older shell) / invoke unavailable → server path.
      }
    }
    if (!await canUseContentOriginDesktopActions()) {
      toast.info('Window focus is available only in the desktop GUI connected to its local Server.');
      return;
    }
    try {
      const r = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: row.id, pid: row.pid, windowId: row.windowId }),
      });
      const data = (await r.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (!r.ok || data?.status !== 'ok') {
        toast.error(`Focus failed: ${data?.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success('Window focused.', { duration: 2000 });
    } catch (e: unknown) {
      toast.error(`Focus failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Option A — open a fresh OMP at the same plan. No session id;
  // new conversation, same workspace context.
  const freshRow = useCallback(async (row: SessionRow) => {
    const result = await launchAgent({
      slug: null,
      planSlug: row.planSlug,
      label: row.label ? agentDisplayLabel(row.label, t) : row.planSlug ?? `fresh-${row.id}`,
    });
    if (result.ok) {
      toast.success('Agent launched (fresh session).', { duration: 3000 });
      setRefreshTick((t) => t + 1);
    } else if (result.installCmd) {
      toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
    } else {
      toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
    }
  }, [t]);

  // Option B — resume an OMP session by id. The id is tracked
  // automatically: we prefer the row's PG-recorded `ompThreadId`
  // (populated by `resolveAndStoreOmpThreadIdForAdvSession`), and
  // fall back to the session header id from the loaded state. No
  // user prompt — if neither exists, the button is disabled and a
  // toast explains why on click.
  const resolveResumeId = useCallback(
    (row: SessionRow): string | null => {
      // 1. PG-stored thread id wins — it's the persisted, canonical link.
      const stored = row.ompThreadId?.trim();
      if (stored) return stored;
      // 2. Server-attached summary's captured header id (every OMP row
      //    in the list has one whenever the JSONL is loadable).
      const summaryId = row.summary?.ompSessionId?.trim();
      if (summaryId) return summaryId;
      // 3. Last resort: in-memory header id from the loaded detail
      //    state (covers the freshly-selected case where neither of
      //    the above populated yet).
      if (selectedRow?.id === row.id) {
        const headerId = stateData?.state?.header.id?.trim();
        if (headerId) return headerId;
      }
      return null;
    },
    [selectedRow, stateData],
  );

  const resumeByIdRow = useCallback(async (row: SessionRow) => {
    const id = resolveResumeId(row);
    if (!id) {
      toast.error(
        'No agent session id tracked for this row yet. Select the session first so the id can be loaded.',
      );
      return;
    }
    const result = await launchAgent({
      slug: null,
      planSlug: row.planSlug,
      label: row.label ? agentDisplayLabel(row.label, t) : row.planSlug ?? `resume-${row.id}`,
      resumeSessionId: id,
    });
    if (result.ok) {
      toast.success(`Agent resumed (${id.slice(0, 12)}…).`, { duration: 3000 });
      setRefreshTick((t) => t + 1);
    } else if (result.installCmd) {
      toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
    } else {
      toast.error(`Resume failed: ${result.error ?? 'unknown error'}`);
    }
  }, [resolveResumeId, t]);

  // P-010: the server carries the authoritative launch-time harness (with an
  // unambiguous plan fallback for older rows). Keep the loaded plan directory
  // only as a compatibility fallback for pre-migration responses.
  const harnessByPlanSlug = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const p of planList.data?.plans ?? []) {
      if (p.harness) m.set(p.slug, p.harness);
    }
    return m;
  }, [planList.data]);
  const harnessForRow = useCallback(
    (row: SessionRow): string | null =>
      row.harnessSlug ?? (row.planSlug ? harnessByPlanSlug.get(row.planSlug) ?? null : null),
    [harnessByPlanSlug],
  );
  // Option counts come from the independent aggregate, never the downloaded
  // pages. While the pair refetches, retain the option identities but suppress
  // stale numbers until both legs settle.
  const sessionHarnessOptions = useMemo(
    () => buildSessionHarnessOptions(summary, pairedFetching),
    [summary, pairedFetching],
  );

  // The normalized harness predicate runs before LIMIT on the server. Grouping
  // therefore consumes only matching rows and can grow safely by cursor page.
  const grouped = useMemo(() => groupRows(rows ?? []), [rows]);
  const autoExpandedSelectionRef = React.useRef<string | null>(null);

  // Auto-expand a newly-selected deep-linked row once so it becomes
  // visible, but don't immediately re-open a group the user just
  // collapsed while that same row remains selected.
  useEffect(() => {
    if (!selectedRow) {
      autoExpandedSelectionRef.current = null;
      return;
    }
    const group = grouped.find((g) => g.rows.some((r) => r.id === selectedRow.id));
    if (!group) return;
    const token = `${selectedRow.id}:${group.key}`;
    if (expandedGroups.includes(group.key)) {
      autoExpandedSelectionRef.current = token;
      return;
    }
    if (autoExpandedSelectionRef.current === token) return;
    autoExpandedSelectionRef.current = token;
    void setExpandedGroups([...expandedGroups, group.key]);
  }, [selectedRow, grouped, expandedGroups, setExpandedGroups]);

  return (
    <div className="pc-adv-sessions">
      <header className="pc-adv-sessions__head">
        <div className="pc-adv-sessions__head-copy">
          <span className="pc-adv-sessions__kicker">Session recovery</span>
          <h2>Agent sessions</h2>
          <p className="pc-adv-sessions__subhead">
            View current and previous agent sessions, recover them or locate them on your desktop
          </p>
        </div>
        <div className="pc-adv-sessions__launch-card" aria-label="Launch a new agent session">
          <div className="pc-adv-sessions__launch-copy">
            <strong>Start from plan context</strong>
          </div>
          <div className="pc-adv-sessions__head-actions">
            {/* Combobox, not Select, since P-003: `buildLaunchPlanOptions` now
                carries the "updated …" stamp on each option's `detail` line
                rather than baked into its label, and Select has no second
                line to render it on — leaving this as a Select would have
                silently dropped the timestamp from this picker. */}
            <Combobox
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--plan"
              value={launchPlanSlug ?? PLAN_SELECT_PLACEHOLDER}
              emptyValue={PLAN_SELECT_PLACEHOLDER}
              onChange={(value) => void setLaunchPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
              disabled={planList.loading}
              ariaLabel="Plan for new session"
              placeholder={planList.loading ? 'Loading plans…' : 'Select plan…'}
              emptyLabel="No plans match"
              options={launchPlanOptions}
            />
            <Combobox
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--model"
              value={launchModel || MODEL_SELECT_DEFAULT}
              emptyValue={MODEL_SELECT_DEFAULT}
              onChange={(value) => void setLaunchModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
              ariaLabel="Model for new session"
              placeholder="Default"
              emptyLabel="No models match"
              options={OMP_MODEL_OPTIONS}
            />
            <Button
              variant="primary"
              className="pc-adv-sessions__btn pc-adv-sessions__btn--primary pc-adv-sessions__launch-btn"
              onClick={launchNewSession}
              disabled={launchingNew || !selectedLaunchPlan}
            >
              {launchingNew ? 'Launching…' : 'Create new session'}
            </Button>
            <Select
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--agent"
              value={suAgent}
              onChange={(value) => void setSuAgent(value as 'claude' | 'omp' | 'codex')}
              ariaLabel="Agent for Launch SU"
              options={SU_AGENT_OPTIONS}
            />
            <Select
              triggerClassName="pc-adv-sessions__select pc-adv-sessions__select--context"
              value={suContext ?? CONTEXT_SELECT_DEFAULT}
              onChange={(value) =>
                void setSuContext(value === CONTEXT_SELECT_DEFAULT ? null : (value as 'trimmed'))
              }
              ariaLabel="Context size for Launch SU"
              options={SU_CONTEXT_OPTIONS}
            />
            <Button
              variant="ghost"
              className="pc-adv-sessions__btn pc-adv-sessions__launch-su-btn"
              onClick={launchSu}
              disabled={launchingSu}
              title={
                launchPlanSlug
                  ? `Launch ${suAgent}-su for plan ${launchPlanSlug} in the active ${t('pot', { lower: true })}`
                  : `Launch ${suAgent}-su (no plan) in the active ${t('pot', { lower: true })}`
              }
            >
              {launchingSu ? 'Launching…' : `Launch SU${launchPlanSlug ? '' : ' (no plan)'}`}
            </Button>
            <button
              type="button"
              className="pc-adv-sessions__refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
            >
              Refresh
            </button>
            {sessionHarnessOptions.length > 0 || sessionHarnessFilter ? (
              <Select
                ariaLabel={`Filter sessions by ${t('pot', { lower: true })}`}
                triggerClassName="pc-adv-sessions__harness-filter"
                value={sessionHarnessFilter ?? '_all'}
                onChange={(value) => void setSessionHarnessFilter(value === '_all' ? null : value)}
                options={[
                  { value: '_all', label: `All ${t('pot', { plural: true })}` },
                  ...sessionHarnessOptions,
                ]}
              />
            ) : null}
          </div>
        </div>
      </header>

      {error ? <p className="pc-adv-sessions__error">Failed to load: {error}</p> : null}
      <p
        className="pc-adv-sessions__scope"
        data-testid="sessions-history-count"
        data-evidence={loadedCountLabel.evidence}
        aria-live="polite"
        aria-label={
          sessionHarnessFilter && matchedCountLabel.evidence !== 'unknown'
            ? `${loadedCountLabel.ariaLabel}; ${matchedCountLabel.ariaLabel}`
            : loadedCountLabel.ariaLabel
        }
      >
        {loadedCountLabel.summary}
        {sessionHarnessFilter && matchedCountLabel.evidence !== 'unknown'
          ? ` · ${matchedCountLabel.summary} in workspace history`
          : ''}
      </p>
      {rows === null && !error ? <p className="pc-adv-sessions__placeholder">Loading…</p> : null}
      {rows && rows.length === 0 ? (
        <div className="pc-adv-sessions__placeholder">
          <p>
            {sessionHarnessFilter
              ? `No sessions match ${sessionHarnessFilter}.`
              : 'No agent sessions recorded yet. Launches from the Plans tab will appear here.'}
          </p>
          {sessionHarnessFilter ? (
            <Button variant="ghost" onClick={() => void setSessionHarnessFilter(null)}>
              Show all sessions
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="pc-adv-sessions__layout">
        <div className="pc-adv-sessions__listpane">
          {grouped.map((group) => {
            const isExpanded = expandedGroups.includes(group.key);
            const groupStats = pairedFetching ? null : exactPlanStats.get(group.key) ?? null;
            const groupEvidence: CountEvidence = groupStats
              ? {
                  kind: 'corpus',
                  count: groupStats.count,
                  population: group.planSlug
                    ? `the ${group.planSlug} plan group`
                    : 'the no-plan group',
                }
              : { kind: 'unknown', reason: error ? 'failed' : 'updating' };
            const groupCount = filterCountLabel(groupEvidence, 'session');
            const activeCount = groupStats?.active ?? null;
            return (
              <Collapsible.Root
                className="pc-adv-sessions__group"
                key={group.key}
                open={isExpanded}
                onOpenChange={(open) =>
                  void setExpandedGroups(
                    open
                      ? Array.from(new Set([...expandedGroups, group.key]))
                      : expandedGroups.filter((k) => k !== group.key),
                  )
                }
              >
                <Collapsible.Trigger asChild>
                  <button type="button" className="pc-adv-sessions__group-head">
                    <ChevronRight className="pc-adv-sessions__group-chevron" size={13} aria-hidden />
                    <span className="pc-adv-sessions__group-title">
                      {group.planSlug ?? 'No plan · ad-hoc SU sessions'}
                    </span>
                    <span
                      className="pc-adv-sessions__group-count"
                      data-evidence={groupCount.evidence}
                      aria-label={groupCount.ariaLabel}
                    >
                      {groupCount.title}
                    </span>
                    {activeCount !== null && activeCount > 0 ? (
                      <span className="pc-adv-sessions__group-active">
                        {activeCount} active
                      </span>
                    ) : (
                      <Tooltip label={`Last active ${new Date(group.lastActiveMs).toLocaleString()}`}>
                        <span className="pc-adv-sessions__group-last-active">
                          last active {formatLastActive(group.lastActiveMs)}
                        </span>
                      </Tooltip>
                    )}
                  </button>
                </Collapsible.Trigger>
                <Collapsible.Content className="pc-adv-sessions__group-content">
                  <ul className="pc-adv-sessions__list">
                    {group.rows.map((row) => {
                      const active = isActive(row);
                      const selected = selectedRow?.id === row.id;
                      return (
                        <li
                          key={row.id}
                          className={`pc-adv-sessions__row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
                        >
                          <button
                            type="button"
                            className="pc-adv-sessions__row-main"
                            onClick={() => void setSelectedSessionId(String(row.id))}
                          >
                            <span className="pc-adv-sessions__row-meta">
                              <span
                                className={`pc-adv-sessions__badge pc-adv-sessions__badge--${row.mode}`}
                                title={row.agent ? `agent: ${row.agent}` : `mode: ${row.mode}`}
                              >
                                {row.agent ?? row.mode}
                              </span>
                              {row.role ? (
                                <span className="pc-adv-sessions__role-chip" title={`role: ${agentRoleLabel(row.role, t)}`}>
                                  {agentRoleLabel(row.role, t)}
                                </span>
                              ) : null}
                              {row.feature ? (
                                <span className="pc-adv-sessions__feature-chip" title={`feature: ${row.feature}`}>
                                  {row.feature}
                                </span>
                              ) : null}
                              {harnessForRow(row) ? (
                                <span className="pc-adv-sessions__harness-chip" title={`${t('pot', { lower: true })}: ${harnessForRow(row)}`}>
                                  {harnessForRow(row)}
                                </span>
                              ) : null}
                              {row.onDesktop ? (
                                <span
                                  className="pc-adv-sessions__desktop-chip"
                                  title="On the desktop — a live OS window is open on screen; hard-exempt from the idle-session reaper"
                                >
                                  🖥 desktop
                                </span>
                              ) : null}
                              <span className="pc-adv-sessions__row-label">
                                {row.label ? agentDisplayLabel(row.label, t) : row.terminalBin ?? `#${row.id}`}
                              </span>
                              <span className="pc-adv-sessions__row-times">
                                {formatCardDateTime(row.startedAt)}
                                {row.endedAt ? ` · ${formatCardDateTime(row.endedAt)}` : ''}
                              </span>
                            </span>
                            <RowUsagePills summary={row.summary} mode={row.mode} />
                          </button>
                          <div className="pc-adv-sessions__row-actions">
                            {active ? (
                              <button
                                type="button"
                                className="pc-adv-sessions__btn pc-adv-sessions__btn--primary"
                                onClick={() => focusRow(row)}
                              >
                                Focus window
                              </button>
                            ) : (
                              <>
                                <Tooltip label="Open a new agent terminal at this plan (fresh conversation)">
                                  <button
                                    type="button"
                                    className="pc-adv-sessions__btn"
                                    onClick={() => freshRow(row)}
                                  >
                                    Fresh agent
                                  </button>
                                </Tooltip>
                                {(() => {
                                  const resumeId = resolveResumeId(row);
                                  const resumeLabel = resumeId
                                    ? `Resume agent with this session's tracked id (${resumeId.slice(0, 12)}…)`
                                    : 'No agent session id tracked yet — select this session first.';
                                  return (
                                    <Tooltip label={resumeLabel}>
                                      <span className="pc-adv-sessions__tooltip-trigger">
                                        <button
                                          type="button"
                                          className="pc-adv-sessions__btn pc-adv-sessions__btn--primary"
                                          onClick={() => resumeByIdRow(row)}
                                          disabled={!resumeId}
                                        >
                                          Resume
                                        </button>
                                      </span>
                                    </Tooltip>
                                  );
                                })()}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Collapsible.Content>
              </Collapsible.Root>
            );
          })}
          {nextSessionCursor ? (
            <Button
              variant="ghost"
              className="pc-adv-sessions__load-more"
              onClick={() => setSessionCursor(nextSessionCursor)}
              disabled={Boolean(sessionsQuery.fetching)}
            >
              {sessionsQuery.fetching ? 'Loading…' : 'Load older sessions'}
            </Button>
          ) : null}
        </div>

        <SessionDetail
          row={selectedRow}
          stateData={stateData}
          loading={stateLoading}
          error={stateError}
          panel={activePanel}
          onPanelChange={(next) => void setPanel(next)}
          historyQuery={historyQuery}
          onHistoryQueryChange={(next) => void setHistoryQuery(next || null)}
          searchData={searchData}
          searchLoading={searchLoading}
          onRefresh={() => setRefreshTick((t) => t + 1)}
        />
      </div>

      <style>{`
        .pc-adv-sessions {
          display: grid;
          gap: 14px;
          padding: 18px;
          color: var(--fg-dim);
        }
        .pc-adv-sessions__head {
          display: grid;
          grid-template-columns: minmax(240px, 0.82fr) minmax(380px, 1.18fr);
          gap: 10px;
          align-items: stretch;
        }
        .pc-adv-sessions__head-copy,
        .pc-adv-sessions__launch-card {
          border: 1px solid var(--border);
          border-radius: 14px;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--accent), transparent 88%), transparent 28%),
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 3%), color-mix(in oklab, var(--bg), transparent 5%));
        }
        .pc-adv-sessions__head-copy {
          display: grid;
          align-content: center;
          gap: 4px;
          min-width: 0;
          padding: 12px 14px;
        }
        .pc-adv-sessions__kicker {
          color: var(--accent);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-adv-sessions__head h2 {
          margin: 0;
          color: var(--fg);
          font-size: 18px;
          font-weight: 740;
          letter-spacing: 0;
          line-height: 1.05;
        }
        .pc-adv-sessions__subhead {
          margin: 0;
          max-width: 52ch;
          color: var(--fg-mute);
          font-size: 11px;
          line-height: 1.35;
        }
        .pc-adv-sessions__launch-card {
          display: grid;
          align-content: center;
          gap: 8px;
          padding: 12px 14px;
        }
        .pc-adv-sessions__launch-copy {
          display: grid;
          gap: 0;
        }
        .pc-adv-sessions__launch-copy strong {
          color: var(--fg);
          font-size: 12px;
          line-height: 1.2;
        }
        .pc-adv-sessions__head-actions {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-adv-sessions__layout {
          display: grid;
          grid-template-columns: minmax(360px, 0.92fr) minmax(420px, 1.08fr);
          gap: 16px;
          align-items: start;
        }
        .pc-adv-sessions__listpane,
        .pc-adv-sessions__detail {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 16px;
          background:
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 2%), color-mix(in oklab, var(--bg), transparent 4%));
        }
        .pc-adv-sessions__listpane {
          max-height: calc(100vh - 320px);
          overflow: auto;
          padding: 10px;
          scrollbar-width: thin;
        }
        .pc-adv-sessions__select {
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 32px;
          min-width: 132px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 4%);
          color: var(--fg);
          font: inherit;
          font-size: 12px;
          font-weight: 650;
          padding: 0 9px;
          cursor: pointer;
          outline: none;
        }
        .pc-adv-sessions__select:hover {
          border-color: var(--border-strong);
          background: var(--bg-3);
        }
        .pc-adv-sessions__select:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__select[data-disabled] {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .pc-adv-sessions__select--plan {
          flex: 1 1 240px;
          min-width: min(100%, 240px);
          max-width: 380px;
        }
        .pc-adv-sessions__refresh,
        .pc-adv-sessions__btn {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          padding: 0 11px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
        }
        .pc-adv-sessions__refresh:hover,
        .pc-adv-sessions__btn:hover {
          border-color: var(--border-strong);
          background: var(--bg-3);
        }
        .pc-adv-sessions__refresh:focus-visible,
        .pc-adv-sessions__btn:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 28%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__btn--primary {
          border-color: color-mix(in oklab, var(--accent), transparent 48%);
          background: color-mix(in oklab, var(--accent), var(--bg) 72%);
          color: var(--fg);
        }
        .pc-adv-sessions__launch-btn {
          min-width: 136px;
        }
        .pc-adv-sessions__btn:disabled {
          opacity: 0.48;
          cursor: not-allowed;
          transform: none;
        }
        .pc-adv-sessions__tooltip-trigger {
          display: inline-flex;
        }
        .pc-adv-sessions__error,
        .pc-adv-sessions__placeholder {
          margin: 0;
          padding: 12px;
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg-mute);
          font-size: 13px;
          line-height: 1.45;
        }
        .pc-adv-sessions__placeholder p {
          margin: 0 0 8px;
        }
        .pc-adv-sessions__scope {
          margin: 0;
          color: var(--fg-mute);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .pc-adv-sessions__error {
          color: var(--bad);
          border: 1px solid color-mix(in oklab, var(--bad), transparent 58%);
          background: color-mix(in oklab, var(--bad), transparent 92%);
        }
        .pc-adv-sessions__group + .pc-adv-sessions__group {
          margin-top: 8px;
        }
        .pc-adv-sessions__load-more {
          width: 100%;
          margin-top: 10px;
        }
        .pc-adv-sessions__group-head {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 8px 9px;
          width: 100%;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 1%);
          transition: background-color 120ms ease, border-color 120ms ease;
        }
        .pc-adv-sessions__group-head:hover {
          background: var(--bg-3);
          border-color: var(--border-strong);
        }
        .pc-adv-sessions__group-head:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__group-chevron {
          color: var(--fg-mute);
          flex: 0 0 auto;
          transition: transform 140ms ease, color 120ms ease;
        }
        .pc-adv-sessions__group-head[data-state="open"] .pc-adv-sessions__group-chevron {
          transform: rotate(90deg);
          color: var(--accent);
        }
        .pc-adv-sessions__group-title {
          color: var(--fg);
          font-size: 13px;
          font-weight: 740;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-sessions__group-count {
          color: var(--fg-mute);
          font-family: ui-monospace, monospace;
          font-size: 11px;
        }
        .pc-adv-sessions__group-active {
          padding: 2px 7px;
          border: 1px solid color-mix(in oklab, var(--accent), transparent 56%);
          border-radius: 999px;
          background: color-mix(in oklab, var(--accent), transparent 86%);
          color: var(--accent);
          font-size: 10px;
          font-weight: 750;
          letter-spacing: 0;
        }
        .pc-adv-sessions__group-last-active {
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: color-mix(in oklab, var(--fg-mute), transparent 88%);
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .pc-adv-sessions__group-content {
          padding: 7px 0 2px;
        }
        .pc-adv-sessions__list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 7px;
        }
        .pc-adv-sessions__row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 12px;
          padding: 10px;
          border: 1px solid color-mix(in oklab, var(--border), transparent 25%);
          border-radius: 13px;
          background: color-mix(in oklab, var(--bg), white 2%);
          transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
        }
        .pc-adv-sessions__row:hover {
          border-color: var(--border-strong);
          background: color-mix(in oklab, var(--bg-3), var(--bg) 72%);
        }
        .pc-adv-sessions__row.is-active {
          border-color: color-mix(in oklab, var(--accent), transparent 48%);
          background: color-mix(in oklab, var(--accent), transparent 91%);
        }
        .pc-adv-sessions__row.is-selected {
          border-color: color-mix(in oklab, var(--warn), transparent 38%);
          box-shadow: 0 0 0 1px color-mix(in oklab, var(--warn), transparent 82%) inset;
        }
        .pc-adv-sessions__row-main {
          all: unset;
          cursor: pointer;
          min-width: 0;
          display: grid;
          gap: 6px;
        }
        .pc-adv-sessions__row-main:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 24%);
          outline-offset: 3px;
          border-radius: 8px;
        }
        .pc-adv-sessions__row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 12px;
        }
        .pc-adv-sessions__badge {
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 780;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-adv-sessions__badge--omp {
          background: color-mix(in oklab, var(--accent), transparent 84%);
          color: var(--accent);
        }
        .pc-adv-sessions__badge--console {
          background: color-mix(in oklab, var(--warn), transparent 86%);
          color: var(--warn);
        }
        .pc-adv-sessions__harness-chip {
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent-strong), transparent 88%);
          color: var(--accent-soft, #bae6fd);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0;
        }
        .pc-adv-sessions__role-chip {
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent), transparent 84%);
          color: #c4b5fd;
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-adv-sessions__feature-chip {
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--good, #34d399), transparent 86%);
          color: #6ee7b7;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          font-weight: 700;
        }
        .pc-adv-sessions__desktop-chip {
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
          color: var(--accent-soft, #bae6fd);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0;
          white-space: nowrap;
        }
        .pc-adv-sessions__harness-filter {
          padding: 4px 6px;
          background: var(--bg-2);
          color: var(--fg);
          border: 1px solid color-mix(in oklab, var(--accent), transparent 62%);
          border-radius: 6px;
          font-size: 12px;
          font-family: inherit;
        }
        .pc-adv-sessions__row-label {
          color: var(--fg);
          font-size: 13px;
          font-weight: 700;
        }
        .pc-adv-sessions__row-times {
          color: var(--fg-mute);
        }
        .pc-adv-sessions__row-usage {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-wrap: wrap;
        }
        .pc-adv-sessions__row-usage-pill {
          display: inline-block;
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: var(--fg-dim);
          font-family: ui-monospace, monospace;
          font-size: 10px;
          font-weight: 650;
          letter-spacing: 0;
          white-space: nowrap;
        }
        .pc-adv-sessions__row-usage-pill--model {
          border-color: color-mix(in oklab, var(--accent), transparent 54%);
          background: color-mix(in oklab, var(--accent), transparent 86%);
          color: var(--accent);
        }
        .pc-adv-sessions__row-usage-pill--cost {
          border-color: color-mix(in oklab, var(--good), transparent 56%);
          background: color-mix(in oklab, var(--good), transparent 88%);
          color: var(--good);
        }
        .pc-adv-sessions__row-usage--loading .pc-adv-sessions__row-usage-pill {
          opacity: 0.5;
          background: transparent;
        }
        .pc-adv-sessions__row-pid,
        .pc-adv-sessions__mono {
          color: var(--fg-mute);
          font-family: ui-monospace, monospace;
          font-size: 11px;
          word-break: break-all;
        }
        .pc-adv-sessions__row-actions {
          display: flex;
          gap: 7px;
          flex-shrink: 0;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .pc-adv-sessions__detail {
          position: sticky;
          top: 12px;
          display: grid;
          grid-template-rows: auto auto minmax(0, 1fr);
          max-height: calc(100vh - 166px);
          overflow: hidden;
        }
        .pc-adv-sessions__detail-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 14px;
          border-bottom: 1px solid var(--border);
          background: color-mix(in oklab, var(--bg-2), white 2%);
        }
        .pc-adv-sessions__detail-title {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .pc-adv-sessions__detail-title h3 {
          margin: 0;
          color: var(--fg);
          font-size: 15px;
          line-height: 1.25;
        }
        .pc-adv-sessions__detail-sub {
          color: var(--fg-mute);
          font-size: 12px;
        }
        .pc-adv-sessions__panel-tabs {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
        }
        .pc-adv-sessions__panel-tablist {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .pc-adv-sessions__panel-tab {
          all: unset;
          cursor: pointer;
          padding: 5px 9px;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--fg-dim);
          font-size: 11px;
          font-weight: 760;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-sessions__panel-tab:hover {
          border-color: var(--border-strong);
          color: var(--fg);
          background: var(--bg-3);
        }
        .pc-adv-sessions__panel-tab[aria-selected="true"],
        .pc-adv-sessions__panel-tab[data-state="active"] {
          border-color: var(--accent);
          background: var(--accent);
          color: var(--accent-ink);
        }
        .pc-adv-sessions__panel-tab:focus-visible {
          outline: 2px solid color-mix(in oklab, var(--accent), transparent 30%);
          outline-offset: 2px;
        }
        .pc-adv-sessions__panel {
          display: grid;
          gap: 12px;
          min-height: 0;
          overflow: auto;
          padding: 14px;
        }
        .pc-adv-sessions__cards {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 8px;
        }
        .pc-adv-sessions__card {
          display: grid;
          gap: 3px;
          padding: 10px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 2%);
        }
        .pc-adv-sessions__card-label {
          color: var(--fg-mute);
          font-size: 10px;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-adv-sessions__card-value {
          color: var(--fg);
          font-size: 14px;
          font-weight: 760;
        }
        .pc-adv-sessions__section {
          display: grid;
          gap: 8px;
        }
        .pc-adv-sessions__section h4 {
          margin: 0;
          color: var(--fg);
          font-size: 12px;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-adv-sessions__snippet-list {
          display: grid;
          gap: 7px;
        }
        .pc-adv-sessions__snippet,
        .pc-adv-sessions__todo-phase,
        .pc-adv-sessions__data-list {
          border: 1px solid var(--border);
          border-radius: 12px;
          background: color-mix(in oklab, var(--bg-2), white 1%);
        }
        .pc-adv-sessions__snippet {
          padding: 9px;
        }
        .pc-adv-sessions__snippet-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 4px;
          color: var(--fg-mute);
          font-size: 11px;
        }
        .pc-adv-sessions__snippet-text {
          margin: 0;
          color: var(--fg-dim);
          font-size: 12px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .pc-adv-sessions__todo-phase {
          padding: 10px;
        }
        .pc-adv-sessions__todo-phase h4 {
          margin: 0 0 7px;
          color: var(--fg);
          font-size: 13px;
        }
        .pc-adv-sessions__todo-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 5px;
        }
        .pc-adv-sessions__todo-item {
          color: var(--fg-dim);
          font-size: 12px;
        }
        .pc-adv-sessions__todo-item[data-status="completed"] { color: var(--good); }
        .pc-adv-sessions__todo-item[data-status="in_progress"] { color: var(--warn); }
        .pc-adv-sessions__todo-item[data-status="abandoned"] { color: var(--bad); }
        .pc-adv-sessions__data-list {
          overflow: hidden;
        }
        .pc-adv-sessions__data-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: center;
          padding: 8px 10px;
          color: var(--fg-dim);
          font-size: 12px;
        }
        .pc-adv-sessions__data-row + .pc-adv-sessions__data-row {
          border-top: 1px solid var(--border);
        }
        .pc-adv-sessions__data-row strong {
          color: var(--fg);
        }
        .pc-adv-sessions__data-row--head {
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-adv-sessions__data-list--tools .pc-adv-sessions__data-row {
          grid-template-columns: minmax(150px, 1.4fr) repeat(3, minmax(56px, 0.45fr)) minmax(112px, 0.8fr);
        }
        .pc-adv-sessions__bad {
          color: var(--bad);
          font-weight: 750;
        }
        .pc-adv-sessions__search {
          display: flex;
          gap: 8px;
        }
        .pc-adv-sessions__search input {
          flex: 1;
          min-width: 0;
        }

        /* Right sidebar detail pass: keep the same panel structure, but make
           the selected session readable, compact, and easier to operate. */
        .pc-adv-sessions__detail {
          border-color: color-mix(in oklab, var(--border), var(--accent) 14%);
          background:
            radial-gradient(circle at top right, color-mix(in oklab, var(--accent), transparent 92%), transparent 32%),
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 4%), color-mix(in oklab, var(--bg), transparent 4%));
          box-shadow:
            0 18px 42px rgba(0, 0, 0, 0.22),
            inset 0 1px 0 rgb(from var(--fg) r g b / 0.045);
        }
        .pc-adv-sessions__detail > .pc-adv-sessions__detail-head,
        .pc-adv-sessions__detail > .pc-adv-sessions__panel-tabs,
        .pc-adv-sessions__detail > .pc-adv-sessions__panel {
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
          min-width: 0;
        }
        .pc-adv-sessions__detail-head {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: flex-start;
          gap: 10px;
          padding: 12px;
          background:
            linear-gradient(180deg, color-mix(in oklab, var(--bg-3), var(--accent) 5%), color-mix(in oklab, var(--bg-2), transparent 4%));
        }
        .pc-adv-sessions__detail-head .pc-adv-sessions__refresh {
          align-self: flex-start;
          flex: 0 0 auto;
          min-height: 28px;
          padding: 0 9px;
          border-radius: 9px;
          font-size: 11px;
          white-space: nowrap;
        }
        .pc-adv-sessions__detail-title {
          gap: 5px;
          min-width: 0;
        }
        .pc-adv-sessions__detail-title h3 {
          display: -webkit-box;
          max-height: 38px;
          overflow: hidden;
          color: color-mix(in oklab, var(--fg), white 6%);
          font-size: 14px;
          font-weight: 780;
          line-height: 1.25;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
        }
        .pc-adv-sessions__detail-sub {
          display: block;
          overflow: hidden;
          color: color-mix(in oklab, var(--fg-mute), white 12%);
          font-family: ui-monospace, monospace;
          font-size: 10.5px;
          line-height: 1.35;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-sessions__panel-tabs {
          overflow: hidden;
          padding: 8px 10px;
          background: color-mix(in oklab, var(--bg-2), black 2%);
        }
        .pc-adv-sessions__panel-tablist {
          min-width: 0;
          max-width: 100%;
          display: flex;
          flex-wrap: nowrap;
          gap: 4px;
          overflow-x: auto;
          padding-bottom: 1px;
          scrollbar-width: thin;
        }
        .pc-adv-sessions__panel-tab {
          box-sizing: border-box;
          min-height: 25px;
          flex: 0 0 auto;
          padding: 4px 6px;
          border-color: color-mix(in oklab, var(--border), white 6%);
          background: color-mix(in oklab, var(--bg-2), white 2%);
          color: color-mix(in oklab, var(--fg-dim), white 8%);
          font-size: 10.5px;
          line-height: 1;
        }
        .pc-adv-sessions__panel-tab:hover {
          background: color-mix(in oklab, var(--bg-3), var(--accent) 4%);
        }
        .pc-adv-sessions__panel-tab[aria-selected="true"],
        .pc-adv-sessions__panel-tab[data-state="active"] {
          border-color: color-mix(in oklab, var(--accent), white 4%);
          background: var(--accent);
          color: var(--accent-ink);
          box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent), transparent 72%) inset;
        }
        .pc-adv-sessions__panel {
          gap: 10px;
          padding: 12px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__placeholder {
          border: 1px solid color-mix(in oklab, var(--border), white 6%);
          background: color-mix(in oklab, var(--bg-2), white 3%);
          color: color-mix(in oklab, var(--fg-mute), white 10%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__cards {
          grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
          gap: 7px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__card {
          gap: 4px;
          padding: 9px;
          border-color: color-mix(in oklab, var(--border), white 6%);
          background:
            linear-gradient(180deg, color-mix(in oklab, var(--bg-2), white 4%), color-mix(in oklab, var(--bg), transparent 2%));
        }
        .pc-adv-sessions__panel .pc-adv-sessions__card-label {
          color: color-mix(in oklab, var(--fg-mute), white 14%);
          font-size: 9.5px;
          font-weight: 760;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__card-value {
          overflow: hidden;
          color: color-mix(in oklab, var(--fg), white 6%);
          font-size: 13px;
          line-height: 1.25;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__section {
          gap: 7px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__section h4 {
          display: flex;
          align-items: center;
          gap: 7px;
          color: color-mix(in oklab, var(--fg), white 5%);
          font-size: 10.5px;
          font-weight: 800;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__section h4::before {
          content: "";
          width: 6px;
          height: 6px;
          flex: 0 0 auto;
          border-radius: 999px;
          background: var(--accent);
          opacity: 0.9;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__snippet,
        .pc-adv-sessions__panel .pc-adv-sessions__todo-phase,
        .pc-adv-sessions__panel .pc-adv-sessions__data-list {
          border-color: color-mix(in oklab, var(--border), white 6%);
          background: color-mix(in oklab, var(--bg-2), white 3%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__snippet {
          padding: 8px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__snippet-meta {
          gap: 6px;
          margin-bottom: 5px;
          color: color-mix(in oklab, var(--fg-mute), white 14%);
          font-size: 10px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__snippet-meta span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__snippet-text {
          max-height: 148px;
          overflow: auto;
          color: color-mix(in oklab, var(--fg-dim), white 9%);
          font-size: 11.5px;
          line-height: 1.45;
          scrollbar-width: thin;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__mono {
          color: color-mix(in oklab, var(--fg-mute), white 15%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__data-row {
          min-height: 34px;
          padding: 7px 9px;
          color: color-mix(in oklab, var(--fg-dim), white 8%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__data-row + .pc-adv-sessions__data-row {
          border-top-color: color-mix(in oklab, var(--border), transparent 12%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__data-row strong {
          color: color-mix(in oklab, var(--fg), white 6%);
          font-weight: 780;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__data-row--head {
          color: color-mix(in oklab, var(--fg-mute), white 12%);
        }
        .pc-adv-sessions__panel .pc-adv-sessions__todo-phase {
          padding: 9px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__todo-phase h4 {
          margin-bottom: 6px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__todo-list {
          gap: 4px;
        }
        .pc-adv-sessions__panel .pc-adv-sessions__todo-item {
          color: color-mix(in oklab, var(--fg-dim), white 8%);
          font-size: 11.5px;
          line-height: 1.35;
        }
        .pc-adv-sessions__search input {
          min-height: 32px;
          border-color: color-mix(in oklab, var(--border), white 6%);
          background: color-mix(in oklab, var(--bg-2), white 3%);
          color: var(--fg);
          font-size: 12px;
        }
        @media (max-width: 1100px) {
          .pc-adv-sessions__head,
          .pc-adv-sessions__layout {
            grid-template-columns: 1fr;
          }
          .pc-adv-sessions__detail {
            position: static;
            max-height: none;
          }
          .pc-adv-sessions__listpane {
            max-height: none;
          }
        }
        @media (max-width: 720px) {
          .pc-adv-sessions {
            padding: 12px;
          }
          .pc-adv-sessions__head-actions {
            align-items: stretch;
            flex-direction: column;
          }
          .pc-adv-sessions__row {
            align-items: stretch;
            grid-template-columns: 1fr;
          }
          .pc-adv-sessions__select,
          .pc-adv-sessions__btn,
          .pc-adv-sessions__refresh,
          .pc-adv-sessions__tooltip-trigger {
            width: 100%;
          }
          .pc-adv-sessions__row-actions {
            justify-content: stretch;
          }
          .pc-adv-sessions__data-list--tools .pc-adv-sessions__data-row {
            grid-template-columns: 1fr 1fr;
          }
          .pc-adv-sessions__data-row--head {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}

function SessionDetail({
  row,
  stateData,
  loading,
  error,
  panel,
  onPanelChange,
  historyQuery,
  onHistoryQueryChange,
  searchData,
  searchLoading,
  onRefresh,
}: {
  row: SessionRow | null;
  stateData: SessionStateResponse | null;
  loading: boolean;
  error: string | null;
  panel: SessionPanel;
  onPanelChange: (panel: SessionPanel) => void;
  historyQuery: string;
  onHistoryQueryChange: (query: string) => void;
  searchData: SessionSearchResponse | null;
  searchLoading: boolean;
  onRefresh: () => void;
}) {
  const t = useLexicon();
  if (!row) {
    return (
      <aside className="pc-adv-sessions__detail">
        <div className="pc-adv-sessions__panel">
          <p className="pc-adv-sessions__placeholder">
            Select a session to inspect its transcript state, todos, tools, and handoff context.
          </p>
        </div>
      </aside>
    );
  }

  const state = stateData?.state ?? null;
  const title = row.label
    ? agentDisplayLabel(row.label, t)
    : row.planSlug || state?.header.title || `Session #${row.id}`;

  return (
    <aside className="pc-adv-sessions__detail">
      <header className="pc-adv-sessions__detail-head">
        <div className="pc-adv-sessions__detail-title">
          <h3 title={state?.header.title || title}>{title}</h3>
          <span className="pc-adv-sessions__detail-sub">
            {row.mode} · started {formatDate(row.startedAt)}
            {state?.header.id ? ` · ${state.header.id.slice(0, 13)}…` : ''}
          </span>
        </div>
        <button type="button" className="pc-adv-sessions__refresh" onClick={onRefresh}>
          Reload state
        </button>
      </header>

      <Tabs.Root
        value={panel}
        onValueChange={(value) => onPanelChange(value as SessionPanel)}
        className="pc-adv-sessions__panel-tabs"
      >
        <Tabs.List className="pc-adv-sessions__panel-tablist" aria-label="Session detail panels">
          {SESSION_PANELS.map((p) => (
            <Tabs.Trigger key={p.value} value={p.value} className="pc-adv-sessions__panel-tab">
              {p.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <div className="pc-adv-sessions__panel">
        {/* Only show the loading placeholder on the INITIAL load — a
            refetch (Refresh button, explicit user action) keeps the
            stale content visible underneath instead of clearing the
            panel to a single line of text every time. */}
        {loading && !stateData ? (
          <p className="pc-adv-sessions__placeholder">Loading session state…</p>
        ) : null}
        {error ? <p className="pc-adv-sessions__error">Failed to load session state: {error}</p> : null}
        {!loading && !error && row.mode !== 'omp' ? (
          <p className="pc-adv-sessions__placeholder">
            This is a console session, not an agent transcript. Focus or resume controls still work; transcript panels apply to agent sessions.
          </p>
        ) : null}
        {!loading && !error && row.mode === 'omp' && !state ? (
          <p className="pc-adv-sessions__placeholder">
            No matching agent transcript found yet. If this terminal just launched, wait for the agent to write its session header and refresh.
          </p>
        ) : null}
        {state ? (
          <SessionPanelContent
            panel={panel}
            row={row}
            stateData={stateData}
            historyQuery={historyQuery}
            onHistoryQueryChange={onHistoryQueryChange}
            searchData={searchData}
            searchLoading={searchLoading}
          />
        ) : null}
      </div>
    </aside>
  );
}

function SessionPanelContent({
  panel,
  row,
  stateData,
  historyQuery,
  onHistoryQueryChange,
  searchData,
  searchLoading,
}: {
  panel: SessionPanel;
  row: SessionRow;
  stateData: SessionStateResponse | null;
  historyQuery: string;
  onHistoryQueryChange: (query: string) => void;
  searchData: SessionSearchResponse | null;
  searchLoading: boolean;
}) {
  const state = stateData?.state;
  if (!state) return null;

  if (panel === 'todos') return <TodosPanel phases={state.todos} />;
  if (panel === 'tools') return <ToolsPanel tools={state.toolCounts} />;
  if (panel === 'jobs') return <SnippetPanel title="Job tool events" empty="No persisted job tool events in this session." snippets={state.jobs} />;
  if (panel === 'goal') return <SnippetPanel title="Goal tool events" empty="No persisted goal tool events in this session." snippets={state.goals} />;
  if (panel === 'memory') return <MemoryPanel memory={stateData?.memory} />;
  if (panel === 'context') return <ContextPanel row={row} stateData={stateData} state={state} />;
  if (panel === 'handoff') {
    return (
      <>
        <SnippetPanel title="Handoffs" empty="No handoff entries found in this session." snippets={state.handoffs} />
        <SnippetPanel title="Compactions" empty="No compaction entries found in this session." snippets={state.compactions} />
      </>
    );
  }
  if (panel === 'history') {
    return (
      <HistoryPanel
        query={historyQuery}
        onQueryChange={onHistoryQueryChange}
        latestMessages={state.latestMessages}
        searchData={searchData}
        loading={searchLoading}
      />
    );
  }

  const usage = normalizeUsage(state.usage);
  const models = state.models ?? [];
  return (
    <>
      <div className="pc-adv-sessions__cards">
        <MetricCard label="Model" value={formatModelLabel(state.latestModel ?? null) ?? '—'} />
        <MetricCard label="Total tokens" value={formatCompactNumber(usage.totalTokens)} />
        <MetricCard label="Cost (USD)" value={formatCostUsd(usage.totalCostUsd)} />
        <MetricCard label="Messages" value={state.messages.total} />
        <MetricCard label="User turns" value={state.messages.user} />
        <MetricCard label="Tool results" value={state.messages.toolResults} />
      </div>
      {usage.assistantTurnsWithUsage > 0 ? (
        <div className="pc-adv-sessions__cards">
          <MetricCard label="Input tokens" value={formatCompactNumber(usage.inputTokens)} />
          <MetricCard label="Output tokens" value={formatCompactNumber(usage.outputTokens)} />
          <MetricCard label="Cache read" value={formatCompactNumber(usage.cacheReadTokens)} />
          <MetricCard label="Cache write" value={formatCompactNumber(usage.cacheWriteTokens)} />
        </div>
      ) : null}
      {models.length > 1 ? (
        <div className="pc-adv-sessions__section">
          <h4>Models used</h4>
          <p className="pc-adv-sessions__snippet-text">{models.map(formatModelLabel).join(' → ')}</p>
        </div>
      ) : null}
      <div className="pc-adv-sessions__section">
        <h4>Agent session</h4>
        <div className="pc-adv-sessions__snippet">
          <div className="pc-adv-sessions__snippet-meta">
            <span>{state.header.id}</span>
            <span>{formatDate(state.header.timestamp)}</span>
            {stateData?.match ? (
              <span>
                match {stateData.match.matchKind} · {Math.round(stateData.match.timeDriftMs / 1000)}s drift
              </span>
            ) : null}
          </div>
          <p className="pc-adv-sessions__snippet-text">
            {state.header.title || '(untitled)'}{'\n'}
            cwd: <span className="pc-adv-sessions__mono">{state.header.cwd}</span>{'\n'}
            file: <span className="pc-adv-sessions__mono">{state.filePath}</span>{'\n'}
            adv row: #{row.id} · plan {row.planSlug ?? '(none)'}
          </p>
        </div>
      </div>
      <SnippetPanel title="Latest transcript snippets" empty="No messages found." snippets={state.latestMessages} />
    </>
  );
}

function ContextPanel({
  row,
  stateData,
  state,
}: {
  row: SessionRow;
  stateData: SessionStateResponse | null;
  state: OmpSessionState;
}) {
  const effectiveAdv = stateData?.advSession ?? row;
  const match = stateData?.match;
  const counts = Object.entries(state.countsByType).sort((a, b) => b[1] - a[1]);
  const searchInstruction =
    `Use omp:sessions op='search' sessionId='${state.header.id}' query='<decision/error/file>' ` +
    `or open /adv/sessions?session=${row.id}&panel=history&q=<query>.`;
  return (
    <>
      <div className="pc-adv-sessions__section">
        <h4>Successor context pointer</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            If the next agent needs context for a decision, search this origin agent session before guessing.{'\n'}
            <span className="pc-adv-sessions__mono">{searchInstruction}</span>
          </p>
        </div>
      </div>

      <div className="pc-adv-sessions__section">
        <h4>Identity and linkage</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            adv row: #{row.id} · plan {row.planSlug ?? '(none)'} · pid {row.pid ?? '—'}{'\n'}
            stored omp_thread_id: <span className="pc-adv-sessions__mono">{effectiveAdv.ompThreadId ?? 'not linked yet'}</span>{'\n'}
            current session id: <span className="pc-adv-sessions__mono">{state.header.id}</span>{'\n'}
            match: {match ? `${match.matchKind} · ${Math.round(match.timeDriftMs / 1000)}s drift` : 'direct id'}{'\n'}
            cwd: <span className="pc-adv-sessions__mono">{state.header.cwd}</span>{'\n'}
            file: <span className="pc-adv-sessions__mono">{state.filePath}</span>
          </p>
        </div>
      </div>

      <div className="pc-adv-sessions__section">
        <h4>Persisted entry types</h4>
        {counts.length === 0 ? (
          <p className="pc-adv-sessions__placeholder">No persisted entries found.</p>
        ) : (
          <div className="pc-adv-sessions__data-list" role="list">
            {counts.map(([type, count]) => (
              <div className="pc-adv-sessions__data-row" role="listitem" key={type}>
                <span className="pc-adv-sessions__mono">{type}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TodosPanel({ phases }: { phases: OmpTodoPhase[] }) {
  if (phases.length === 0) {
    return <p className="pc-adv-sessions__placeholder">No todo_write state found in this session.</p>;
  }
  return (
    <div className="pc-adv-sessions__section">
      {phases.map((phase) => (
        <div className="pc-adv-sessions__todo-phase" key={phase.name}>
          <h4>{phase.name}</h4>
          <ul className="pc-adv-sessions__todo-list">
            {phase.tasks.map((task) => (
              <li className="pc-adv-sessions__todo-item" data-status={task.status} key={`${phase.name}:${task.content}`}>
                {statusGlyph(task.status)} {task.content}
                {task.notes?.length ? ` (+${task.notes.length} note${task.notes.length === 1 ? '' : 's'})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ToolsPanel({ tools }: { tools: OmpToolSummary[] }) {
  if (tools.length === 0) {
    return <p className="pc-adv-sessions__placeholder">No tool results found in this session.</p>;
  }
  return (
    <div className="pc-adv-sessions__data-list pc-adv-sessions__data-list--tools" role="list">
      <div className="pc-adv-sessions__data-row pc-adv-sessions__data-row--head" aria-hidden>
        <span>Tool</span>
        <span>Calls</span>
        <span>Results</span>
        <span>Errors</span>
        <span>Last used</span>
      </div>
      {tools.map((tool) => (
        <div className="pc-adv-sessions__data-row pc-adv-sessions__data-row--tools" role="listitem" key={tool.toolName}>
          <span className="pc-adv-sessions__mono">{tool.toolName}</span>
          <strong>{tool.calls}</strong>
          <span>{tool.results}</span>
          <span className={tool.errors > 0 ? 'pc-adv-sessions__bad' : undefined}>{tool.errors}</span>
          <span>{tool.lastUsedAt ? formatDate(tool.lastUsedAt) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryPanel({ memory }: { memory: OmpMemoryState | undefined }) {
  if (!memory) return <p className="pc-adv-sessions__placeholder">Memory config unavailable.</p>;
  if (memory.ok === false) {
    return <p className="pc-adv-sessions__error">Could not read agent memory config: {memory.error}</p>;
  }
  const hindsight = memory.hindsight ?? {};
  return (
    <>
      <div className="pc-adv-sessions__cards">
        <MetricCard label="Backend" value={String(memory.backend ?? 'unknown')} />
        <MetricCard label="Auto recall" value={String(hindsight.autoRecall ?? 'unknown')} />
        <MetricCard label="Auto retain" value={String(hindsight.autoRetain ?? 'unknown')} />
        <MetricCard label="Scoping" value={String(hindsight.scoping ?? 'unknown')} />
      </div>
      <div className="pc-adv-sessions__section">
        <h4>Hindsight</h4>
        <div className="pc-adv-sessions__snippet">
          <p className="pc-adv-sessions__snippet-text">
            apiUrl: <span className="pc-adv-sessions__mono">{String(hindsight.apiUrl ?? 'unset')}</span>{'\n'}
            retainMode: {String(hindsight.retainMode ?? 'unknown')}{'\n'}
            recallBudget: {String(hindsight.recallBudget ?? 'unknown')}{'\n'}
            recallMaxTokens: {String(hindsight.recallMaxTokens ?? 'unknown')}
          </p>
        </div>
      </div>
    </>
  );
}

function HistoryPanel({
  query,
  onQueryChange,
  latestMessages,
  searchData,
  loading,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  latestMessages: OmpMessageSnippet[];
  searchData: SessionSearchResponse | null;
  loading: boolean;
}) {
  const trimmed = query.trim();
  return (
    <>
      <div className="pc-adv-sessions__search">
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search this transcript for decisions, errors, files…"
          aria-label="Search session history"
        />
      </div>
      {loading ? <p className="pc-adv-sessions__placeholder">Searching…</p> : null}
      {searchData?.ok === false && searchData.error ? (
        <p className="pc-adv-sessions__error">Search failed: {searchData.error}</p>
      ) : null}
      {trimmed.length > 0 && !loading ? (
        <div className="pc-adv-sessions__section">
          <h4>
            Search results
            {searchData ? ` · ${searchData.matches.length}${searchData.truncated ? '+' : ''}` : ''}
          </h4>
          {searchData && searchData.matches.length > 0 ? (
            <div className="pc-adv-sessions__snippet-list">
              {searchData.matches.map((match) => (
                <div className="pc-adv-sessions__snippet" key={`${match.session.id}:${match.line}:${match.entryId ?? ''}`}>
                  <div className="pc-adv-sessions__snippet-meta">
                    <span>line {match.line}</span>
                    <span>{match.role ?? match.type}</span>
                    {match.toolName ? <span>{match.toolName}</span> : null}
                    {match.timestamp ? <span>{formatDate(match.timestamp)}</span> : null}
                  </div>
                  <p className="pc-adv-sessions__snippet-text">{match.snippet}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="pc-adv-sessions__placeholder">No matches.</p>
          )}
        </div>
      ) : null}
      {trimmed.length === 0 ? (
        <SnippetPanel title="Latest transcript snippets" empty="No messages found." snippets={latestMessages} />
      ) : null}
    </>
  );
}

function SnippetPanel({
  title,
  empty,
  snippets,
}: {
  title: string;
  empty: string;
  snippets: OmpMessageSnippet[];
}) {
  return (
    <div className="pc-adv-sessions__section">
      <h4>{title}</h4>
      {snippets.length === 0 ? (
        <p className="pc-adv-sessions__placeholder">{empty}</p>
      ) : (
        <div className="pc-adv-sessions__snippet-list">
          {snippets.map((snippet, index) => (
            <div className="pc-adv-sessions__snippet" key={`${snippet.id ?? index}:${snippet.timestamp ?? ''}`}>
              <div className="pc-adv-sessions__snippet-meta">
                <span>{snippet.role}</span>
                {snippet.toolName ? <span>{snippet.toolName}</span> : null}
                {snippet.isError ? <span>error</span> : null}
                {snippet.timestamp ? <span>{formatDate(snippet.timestamp)}</span> : null}
              </div>
              <p className="pc-adv-sessions__snippet-text">{snippet.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline pills on the row card — model + tokens + cost. Server
 *  attaches summary on the list response; nothing rendered for
 *  console rows or for OMP rows that haven't materialised yet
 *  (brand-new launches where the JSONL hasn't been written). */
function RowUsagePills({
  summary,
  mode,
}: {
  summary: ServerRowSummary | null;
  mode: 'omp' | 'console';
}) {
  if (mode !== 'omp') return null;
  if (!summary) return null;
  const modelLabel = formatModelLabel(summary.latestModel);
  return (
    <span className="pc-adv-sessions__row-usage">
      {modelLabel ? (
        <span
          className="pc-adv-sessions__row-usage-pill pc-adv-sessions__row-usage-pill--model"
          title={summary.latestModel ?? undefined}
        >
          {modelLabel}
        </span>
      ) : null}
      {summary.totalTokens > 0 ? (
        <span className="pc-adv-sessions__row-usage-pill" title="Total tokens (input + output + cache)">
          {formatCompactNumber(summary.totalTokens)} tok
        </span>
      ) : null}
      {summary.totalCostUsd > 0 ? (
        <span className="pc-adv-sessions__row-usage-pill pc-adv-sessions__row-usage-pill--cost" title="USD cost reported by the agent">
          {formatCostUsd(summary.totalCostUsd)}
        </span>
      ) : null}
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="pc-adv-sessions__card">
      <span className="pc-adv-sessions__card-label">{label}</span>
      <span className="pc-adv-sessions__card-value">{value}</span>
    </div>
  );
}

function isSessionPanel(value: string): value is SessionPanel {
  return SESSION_PANELS.some((panel) => panel.value === value);
}

function statusGlyph(status: OmpTodoItem['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '→';
  if (status === 'abandoned') return '✕';
  return '○';
}

/** Most-recent activity timestamp for a row: endedAt when set,
 *  otherwise startedAt. Used to sort groups + render the
 *  "last active" pill on inactive groups. */
function rowActivityMs(r: SessionRow): number {
  const stamp = r.endedAt ?? r.startedAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : 0;
}

interface GroupRow {
  key: string;
  planSlug: string | null;
  rows: SessionRow[];
  /** Most-recent activity across all rows in the group. Drives the
   *  group sort (newest first) and the "last active" pill. */
  lastActiveMs: number;
}

function groupRows(rows: SessionRow[]): GroupRow[] {
  const map = new Map<string, { planSlug: string | null; rows: SessionRow[] }>();
  for (const r of rows) {
    const key = r.planSlug ?? '_';
    let g = map.get(key);
    if (!g) {
      g = { planSlug: r.planSlug, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  const groups: GroupRow[] = Array.from(map.entries()).map(([key, g]) => ({
    key,
    planSlug: g.planSlug,
    rows: g.rows,
    lastActiveMs: g.rows.reduce((acc, r) => Math.max(acc, rowActivityMs(r)), 0),
  }));
  // Most-recently-active plans first.
  groups.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return groups;
}

/** Compact "last active" label — same shape as the row times. */
function formatLastActive(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const ageMs = Date.now() - ms;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (ageMs < 2 * minute) return 'just now';
  if (ageMs < hour) return `${Math.floor(ageMs / minute)}m ago`;
  if (ageMs < day) return `${Math.floor(ageMs / hour)}h ago`;
  if (ageMs < 30 * day) return `${Math.floor(ageMs / day)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });
}

/** Compact human-readable model label: "claude-opus-4-7" → "Opus 4.7".
 *  Falls through to the raw id for unknowns so unfamiliar providers
 *  still surface something. Null pass-through. */
function formatModelLabel(model: string | null): string | null {
  if (!model) return null;
  // Anthropic: claude-{family}-{version}[-suffix]
  const m = /^claude-(opus|sonnet|haiku)-?(\d[\w.-]*)?/i.exec(model);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
    const ver = m[2] ? ` ${m[2].replace(/-/g, '.')}` : '';
    return `${family}${ver}`;
  }
  // GPT: gpt-{ver}[-suffix]
  const g = /^gpt-?(\d[\w.-]*)/i.exec(model);
  if (g) return `GPT-${g[1]!.replace(/-/g, '.')}`;
  return model;
}

/** 12345 → "12.3K"; 1234567 → "1.23M". Whole numbers under 1k stay bare. */
function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** USD with sensible precision: <$0.01 → "<$0.01"; <$1 → "$0.123";
 *  ≥$1 → "$12.34". Zero pass-through. */
function formatCostUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0';
  if (amount < 0.01) return '<$0.01';
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}
function formatCardDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString(undefined, {
      month: 'numeric',
      day: 'numeric',
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
// buildLaunchPlanOptions / formatLaunchPlanOptionLabel / the
// PLAN_SELECT_PLACEHOLDER + MODEL_SELECT_DEFAULT + OMP_MODEL_OPTIONS
// constants moved to ./NewSessionLauncher (hud-consolidation-2026-07-26
// P-001) so the HUD board header can reuse the exact same "launch from plan
// context" picker without a second implementation. Imported above.
