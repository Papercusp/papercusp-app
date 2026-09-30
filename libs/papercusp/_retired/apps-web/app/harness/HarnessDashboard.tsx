'use client';

import './harness.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Toaster, toast } from 'sonner';
import { Group as PanelGroup, Panel as RPanel, Separator } from 'react-resizable-panels';
import {
  Activity, Play, Square, SlidersHorizontal, RotateCcw,
  Coins, TrendingUp, CheckCircle2, AlertTriangle, Loader2, Wrench, ArrowRight,
  Code2, BookOpen, LayoutDashboard, Lightbulb, FileText,
} from 'lucide-react';

const CODE_SERVER_PORT = 8082;
const DOCS_VIEWER_URL = 'http://127.0.0.1:4325';

function vscodeUrl(projectPath: string): string {
  if (typeof window === 'undefined') return '#';
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${CODE_SERVER_PORT}/?folder=${encodeURIComponent(projectPath)}`;
}

function docsUrl(slug: string): string {
  return `${DOCS_VIEWER_URL}/projects/${slug}/`;
}

const VSCODE_WINDOW_NAME = 'harness-vscode';

function openInVSCode(projectPath: string) {
  const url = vscodeUrl(projectPath);
  if (url === '#') return;
  window.open(url, VSCODE_WINDOW_NAME);
}

type MainPanel = 'brainstorm' | 'proposals' | 'git' | 'dashboard' | 'summary' | 'docs' | 'vscode' | 'insights' | 'config' | 'plugins';

import { createResilientEventSource } from '@papercusp/sse';
import { Panel } from '@papercusp/ui-primitives';
import { StatCard } from '@papercusp/ui-primitives';
import { StatusPill } from '@papercusp/ui-primitives';
import { LogView } from '@papercusp/ui-primitives';
import { MarkdownView } from '@papercusp/ui-primitives';
import { JsonTree } from '@papercusp/ui-primitives';
import { IssuesList } from './issues/IssuesList';
import { preloadGitLog as libPreloadGitLog } from '@papercusp/git-graph';
import PluginTabs from '@/lib/PluginTabs';

function preloadGitLog(slug: string, limit = 300) {
  libPreloadGitLog(`harness:${slug}`, limit, `/api/harness/${slug}/git/log?limit=${limit}`);
}

// Linear-inspired extensions (palette, peek, pulse, insights, triage).
import CommandPalette, { Command } from './CommandPalette';
import FeatureList from './FeatureList';
import FeaturePeekPanel from './FeaturePeekPanel';
import PulseFeed, { usePulse } from './PulseFeed';
import InsightsPanel from './InsightsPanel';
import TriageQueue from './TriageQueue';
import ArchitectInbox from './ArchitectInbox';
import { CollapsedGitRail, CollapsedInboxRail } from './CollapsedRails';
import PhaseTabs, { type Phase } from './PhaseTabs';
import TestsTab from './TestsTab';
import ProposalsPanel from './ProposalsPanel';

/**
 * Wrap a `dynamic()` import with retry + visible loading state so that a
 * one-off chunk fetch failure (services flapping, dev rebuild, network
 * blip) doesn't leave the panel area silently empty. Without this,
 * `dynamic(() => import(x))` swallows the import error and renders
 * nothing — there's no signal that anything went wrong, and the user
 * has to refresh the page to recover.
 */
function dynamicWithRetry<T>(
  loader: () => Promise<T>,
  label: string,
  pickComponent?: (mod: T) => React.ComponentType<any>,
) {
  const importer = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Race the import against an 8s timeout — if the chunk fetches but the
        // module's top-level evaluation hangs (e.g. an internal dep is stalled),
        // we want to fall through to retry/fallback instead of spinning forever.
        const mod = await Promise.race([
          loader(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('import timeout')), 8000)),
        ]) as T;
        return pickComponent ? pickComponent(mod) : (mod as any);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    // Give up — render a visible failure card so the user knows to refresh
    // instead of staring at an empty pane.
    const Fallback = () => (
      <div style={{ padding: 24, color: '#fca5a5', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
        Failed to load <strong>{label}</strong> after 3 attempts.<br />
        <span style={{ color: '#9ca3af', fontSize: 12 }}>
          {String((lastErr as any)?.message ?? lastErr).slice(0, 200)}
        </span>
        <br />
        <button
          onClick={() => location.reload()}
          style={{ marginTop: 12, background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 4, padding: '6px 14px', cursor: 'pointer' }}
        >
          Reload page
        </button>
      </div>
    );
    return Fallback as any;
  };
  return dynamic(importer, {
    ssr: false,
    loading: () => (
      <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>
        loading <em>{label}</em>…
      </div>
    ),
  });
}

const SpecEditor = dynamicWithRetry(() => import('./SpecEditor'), 'SpecEditor');
const EscalationBanner = dynamicWithRetry(() => import('./EscalationBanner'), 'EscalationBanner');
const CheckpointBanner = dynamicWithRetry(() => import('./CheckpointBanner'), 'CheckpointBanner');
const GitGraphPanelLib = dynamicWithRetry(
  () => import('@papercusp/git-graph').then((m) => ({ default: m.GitGraphPanel })),
  'GitGraphPanel',
);
function GitGraphPanel({ slug }: { slug: string }) {
  return (
    <GitGraphPanelLib
      scope={`harness:${slug}`}
      gitLogUrl={(limit: number) => `/api/harness/${slug}/git/log?limit=${limit}`}
      showCommitUrl={(sha: string) => `/api/harness/${slug}/git/show/${sha}`}
    />
  );
}
const BrainstormFull = dynamicWithRetry(() => import('./brainstorm/BrainstormFull'), 'Brainstorm', (m: any) => m.BrainstormFull);
const HooksPanel = dynamicWithRetry(() => import('./HooksPanel'), 'HooksPanel');
const FeatureEditor = dynamicWithRetry(() => import('./FeatureEditor'), 'FeatureEditor');
const InterventionPanel = dynamicWithRetry(() => import('./InterventionPanel'), 'InterventionPanel');
const UsagePanel = dynamicWithRetry(() => import('./UsagePanel'), 'UsagePanel');
const SnapshotsPanel = dynamicWithRetry(() => import('./SnapshotsPanel'), 'SnapshotsPanel');
const ScreenshotsPanel = dynamicWithRetry(() => import('./ScreenshotsPanel'), 'ScreenshotsPanel');
const TemplatesModal = dynamicWithRetry(() => import('./TemplatesModal'), 'TemplatesModal');
const FeatureDiffModal = dynamicWithRetry(() => import('./FeatureDiffModal'), 'FeatureDiffModal');
const ArchivesPanel = dynamicWithRetry(() => import('./ArchivesPanel'), 'ArchivesPanel');
const DecisionsPanel = dynamicWithRetry(() => import('./DecisionsPanel'), 'DecisionsPanel');
const HealthBadge = dynamicWithRetry(() => import('./HealthBadge'), 'HealthBadge');
const SmokeTestPanel = dynamicWithRetry(() => import('./SmokeTestPanel'), 'SmokeTestPanel');
const IdentityPanel = dynamic(() => import('./IdentityPanel'), { ssr: false });
const PlanReviewBanner = dynamic(() => import('./PlanReviewBanner'), { ssr: false });
const SummaryPanel = dynamic(() => import('./SummaryPanel'), { ssr: false });

// ─── Types ─────────────────────────────────────────────────────────────

type FeatureStatus = 'todo' | 'in_progress' | 'validating' | 'failing' | 'passed' | 'blocked';

interface ProjectEntry {
  slug: string;
  path: string;
  hasState: boolean;
  hasSpec: boolean;
}

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: FeatureStatus;
  attempts: number;
  summary?: string;
}

interface Status {
  project: { slug: string; path: string };
  features: Feature[];
  counts: Record<string, number>;
  iteration: number;
  lastDecision: string | null;
  alive: boolean;
  escalated: boolean;
  pendingCheckpoints?: number;
  activeCompetitions?: number;
  smokeFail?: boolean;
  missionCostUsd?: number;
  missionInputTokens?: number;
  missionOutputTokens?: number;
}

interface TimelineEntry {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

interface AgentDetail {
  runId: string;
  stdout: string | null;
  stderr: string | null;
  jsonlBytes: number;
  timeline: TimelineEntry[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface AgentRun {
  runId: string;
  role: string;
  ts: number;
  sizeBytes: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const STATUS_ORDER: FeatureStatus[] = ['in_progress', 'validating', 'failing', 'todo', 'blocked', 'passed'];
const FOCUS_ORDER: FeatureStatus[] = ['failing', 'blocked', 'in_progress', 'validating', 'todo', 'passed'];
const STATUS_LABELS: Record<FeatureStatus, string> = {
  todo: 'todo',
  in_progress: 'running',
  validating: 'validating',
  failing: 'failing',
  passed: 'passed',
  blocked: 'blocked',
};

function focusVerb(status: FeatureStatus): string {
  switch (status) {
    case 'failing': return 'Needs recovery';
    case 'blocked': return 'Needs decision';
    case 'in_progress': return 'Watch current run';
    case 'validating': return 'Await validation';
    case 'todo': return 'Next up';
    case 'passed': return 'Recently passed';
    default: return 'Focus';
  }
}

const EMPTY_FEATURES: Feature[] = [];

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// ─── Component ─────────────────────────────────────────────────────────

export default function HarnessDashboard() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [issues, setIssues] = useState<string>('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetail | null>(null);
  const agentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [peekFeature, setPeekFeature] = useState<Feature | null>(null);
  // Left sidebar defaults to 'inbox'; user can flip to git graph via toggle.
  const [leftPane, setLeftPane] = useState<'inbox' | 'git'>('inbox');
  const [activePhase, setActivePhase] = useState<Phase>('staging');
  const [reviewCount, setReviewCount] = useState(0);
  const [showTriage, setShowTriage] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const [showIntervention, setShowIntervention] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showScreenshots, setShowScreenshots] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const [showSmokeTest, setShowSmokeTest] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showArchives, setShowArchives] = useState(false);
  const [diffFeatureId, setDiffFeatureId] = useState<string | null>(null);
  const [editingFeature, setEditingFeature] = useState<Feature | null | 'new'>(null);
  const [lanes, setLanes] = useState<{ lanes: Array<{ pid: number; featureId: string; startedAt: number; elapsedSeconds: number; alive: boolean }>; max: number } | null>(null);
  const [pendingProposals, setPendingProposals] = useState(0);
  const [activePanel, setActivePanel] = useState<MainPanel>('dashboard');
  const [isCompact, setIsCompact] = useState(false);
  const esRef = useRef<{ close: () => void } | null>(null);
  const searchParams = useSearchParams();
  const projectQueryParam = searchParams?.get('project') ?? null;

  useEffect(() => {
    fetch('/api/harness/projects')
      .then((r) => r.json())
      .then((d) => {
        const nextProjects = d.projects ?? [];
        setProjects(nextProjects);
        if (!nextProjects.length) return;
        // Prefer ?project= query param > localStorage > first project
        const fromQuery = projectQueryParam && nextProjects.find((p: ProjectEntry) => p.slug === projectQueryParam)
          ? projectQueryParam
          : null;
        const saved = window.localStorage.getItem('harness.activeProject');
        const savedProject = saved ? nextProjects.find((p: ProjectEntry) => p.slug === saved) : null;
        setActiveSlug((current) => {
          if (fromQuery) return fromQuery;
          if (current && nextProjects.some((p: ProjectEntry) => p.slug === current)) return current;
          return savedProject?.slug ?? nextProjects[0].slug;
        });
      })
      .catch((e) => toast.error(`Failed to load projects: ${e}`));
  }, [projectQueryParam]);

  useEffect(() => {
    if (!activeSlug) return;
    try { window.localStorage.setItem('harness.activeProject', activeSlug); } catch {}
  }, [activeSlug]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setStatus(null);
    setAgents([]);
    setIssues('');
    setLogLines([]);
    setSelectedAgent(null);
    preloadGitLog(activeSlug, 300);
    // Warm the dynamic GitGraphPanel chunk so the first left-pane click doesn't pay Turbopack compile cost.
    import('@papercusp/git-graph').catch(() => {});

    const loadAll = async () => {
      try {
        const q = `?phase=${activePhase}`;
        const [statusRes, agentsRes, issuesRes, logRes] = await Promise.all([
          fetch(`/api/harness/${activeSlug}/status${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/agents${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/issues${q}`).then((r) => r.json()),
          fetch(`/api/harness/${activeSlug}/logs/run${q}`).then((r) => r.json()),
        ]);
        if (statusRes.error) throw new Error(statusRes.error);
        setStatus(statusRes);
        setAgents(agentsRes.runs ?? []);
        setIssues(issuesRes.issues ?? '');
        setLogLines((logRes.log ?? '').split('\n').filter(Boolean));
      } catch (e) {
        toast.error(String(e));
      }
    };
    loadAll();

    const source = createResilientEventSource({
      url: `/api/harness/${activeSlug}/stream?phase=${activePhase}`,
      handlers: {
        log: (chunk) => {
          setLogLines((prev) => {
            const next = [...prev, ...chunk.split('\n').filter(Boolean)];
            return next.length > 5000 ? next.slice(-5000) : next;
          });
        },
        features: (data) => {
          try {
            const features = JSON.parse(data);
            setStatus((prev) => prev ? { ...prev, features } : prev);
          } catch { /* ignore */ }
        },
      },
    });
    esRef.current = source;

    return () => { source.close(); esRef.current = null; };
  }, [activeSlug, activePhase]);

  useEffect(() => {
    if (!activeSlug) return;
    const q = `?phase=${activePhase}`;
    const t = setInterval(() => {
      fetch(`/api/harness/${activeSlug}/status${q}`).then((r) => r.json()).then(setStatus).catch(() => {});
      fetch(`/api/harness/${activeSlug}/agents${q}`).then((r) => r.json()).then((d) => setAgents(d.runs ?? [])).catch(() => {});
      fetch(`/api/harness/${activeSlug}/reviews${q}`).then((r) => r.json()).then((d) => setReviewCount((d.reviews ?? []).length)).catch(() => {});
      fetch(`/api/harness/${activeSlug}/lanes${q}`).then((r) => r.json()).then(setLanes).catch(() => {});
      fetch(`/api/harness/${activeSlug}/proposals`).then((r) => r.json()).then((d) => {
        const pending = (d.proposals ?? []).filter((p: any) => p.status === 'pending').length;
        setPendingProposals(pending);
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [activeSlug, activePhase]);

  const loadAgent = useCallback(async (runId: string) => {
    const r = await fetch(`/api/harness/${activeSlug}/agents/${runId}?phase=${activePhase}`).then((r) => r.json());
    setSelectedAgent(r as AgentDetail);
  }, [activeSlug, activePhase]);


  useEffect(() => {
    if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; }
    if (!selectedAgent || !activeSlug) return;
    const isLive = !selectedAgent.timeline?.some((e) => e.kind === 'result');
    if (!isLive) return;
    agentPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/harness/${activeSlug}/agents/${selectedAgent.runId}?phase=${activePhase}`).then((r) => r.json());
        setSelectedAgent(r as AgentDetail);
      } catch {}
    }, 2000);
    return () => { if (agentPollRef.current) { clearInterval(agentPollRef.current); agentPollRef.current = null; } };
  }, [selectedAgent?.runId, activeSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetFeature = useCallback(async (id: string) => {
    if (!activeSlug) return;
    if (!confirm(`Reset ${id} to todo with attempts=0?`)) return;
    await fetch(`/api/harness/${activeSlug}/features/${id}/reset?phase=${activePhase}`, { method: 'POST' });
    toast.success(`${id} reset`);
  }, [activeSlug]);

  const launchHarness = useCallback(async () => {
    if (!activeSlug) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/launch?phase=${activePhase}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success('Harness launched', { description: d.logPath });
      setTimeout(() => {
        fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
      }, 2000);
    } catch (e) {
      toast.error('Launch failed', { description: String(e) });
    }
  }, [activeSlug]);

  const stopHarness = useCallback(async () => {
    if (!activeSlug) return;
    if (!confirm(`Send SIGTERM to the harness process for ${activeSlug}?`)) return;
    try {
      const res = await fetch(`/api/harness/${activeSlug}/stop?phase=${activePhase}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success(`Stopped ${d.killed?.length ?? 0} process(es)`);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [activeSlug]);

  // ─── Linear-inspired extensions ─────

  const setFeatureStatus = useCallback(async (id: string, s: FeatureStatus) => {
    if (!activeSlug) return;
    const res = await fetch(`/api/harness/${activeSlug}/features/${id}?phase=${activePhase}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: s }),
    });
    if (res.ok) toast.success(`${id} → ${s}`);
    else toast.error(`Failed: ${res.status}`);
  }, [activeSlug]);

  const batchReset = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      fetch(`/api/harness/${activeSlug}/features/${id}/reset?phase=${activePhase}`, { method: 'POST' })
    ));
    toast.success(`Reset ${ids.length} features`);
  }, [activeSlug]);

  const batchDelete = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) =>
      fetch(`/api/harness/${activeSlug}/features/${id}?phase=${activePhase}`, { method: 'DELETE' })
    ));
    toast.success(`Deleted ${ids.length} features`);
    if (peekFeature && ids.includes(peekFeature.id)) setPeekFeature(null);
  }, [activeSlug, peekFeature]);

  // ⌘K toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  // Keep peekFeature in sync with latest features data so status transitions
  // propagate into the open peek panel.
  useEffect(() => {
    if (!peekFeature || !status) return;
    const fresh = status.features.find((f) => f.id === peekFeature.id);
    if (fresh && (fresh.status !== peekFeature.status || fresh.attempts !== peekFeature.attempts)) {
      setPeekFeature(fresh);
    }
  }, [status, peekFeature]);

  // Pulse feed derived from feature snapshots.
  const pulseEvents = usePulse(
    (status?.features ?? EMPTY_FEATURES) as unknown as Parameters<typeof usePulse>[0],
    status?.iteration ?? 0,
    status?.escalated ?? false,
  );

  const totalCount = status?.features.length ?? 0;
  const passedCount = status?.counts.passed ?? 0;
  const progressPct = totalCount ? Math.round((passedCount / totalCount) * 100) : 0;

  const sortedFeatures = useMemo(() => {
    if (!status) return [];
    return [...status.features].sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [status]);

  const statusSummary = useMemo(() => {
    const features = status?.features ?? [];
    return STATUS_ORDER.map((featureStatus) => ({
      status: featureStatus,
      label: STATUS_LABELS[featureStatus],
      count: features.filter((f) => f.status === featureStatus).length,
    })).filter((entry) => entry.count > 0);
  }, [status]);

  const focusFeature = useMemo(() => {
    const features = status?.features ?? [];
    for (const featureStatus of FOCUS_ORDER) {
      const match = features.find((f) => f.status === featureStatus);
      if (match) return match;
    }
    return null;
  }, [status]);


  const commands: Command[] = useMemo(() => {
    const cs: Command[] = [];
    for (const p of projects) {
      cs.push({
        id: `proj:${p.slug}`, section: 'Projects',
        title: p.slug, subtitle: p.path, icon: '📁',
        perform: () => setActiveSlug(p.slug),
      });
      cs.push({
        id: `proj:${p.slug}:vscode`, section: 'Projects',
        title: `Open ${p.slug} in VSCode`, subtitle: p.path, icon: '</>',
        keywords: 'vscode code editor open folder',
        perform: () => openInVSCode(p.path),
      });
    }
    if (activeSlug && status) {
      if (status.alive) {
        cs.push({ id: 'stop', section: 'Control', title: 'Stop harness', icon: '■', perform: stopHarness });
        cs.push({
          id: 'pause', section: 'Control', title: 'Pause harness (SIGSTOP)',
          icon: '⏸', keywords: 'pause suspend stop',
          perform: async () => {
            try {
              const r = await fetch(`/api/harness/${activeSlug}/pause`, { method: 'POST' });
              const d = await r.json();
              toast.info(`paused ${d.paused?.length ?? 0} process(es)`);
            } catch (e) { toast.error(String(e)); }
          },
        });
        cs.push({
          id: 'unpause', section: 'Control', title: 'Unpause harness (SIGCONT)',
          icon: '▶', keywords: 'unpause resume continue',
          perform: async () => {
            try {
              const r = await fetch(`/api/harness/${activeSlug}/unpause`, { method: 'POST' });
              const d = await r.json();
              toast.info(`resumed ${d.resumed?.length ?? 0} process(es)`);
            } catch (e) { toast.error(String(e)); }
          },
        });
      } else {
        cs.push({ id: 'start', section: 'Control', title: 'Start harness', icon: '▶', perform: launchHarness });
      }
      cs.push({ id: 'config', section: 'Control', title: 'Edit config / spec', icon: '✎', keywords: 'spec agents contract', perform: () => setActivePanel('config') });
      cs.push({ id: 'vscode', section: 'Control', title: 'Open current project in VSCode', icon: '</>', keywords: 'vscode code editor open folder', perform: () => openInVSCode(status.project.path) });
      cs.push({ id: 'triage', section: 'Control', title: 'Triage — stuck/blocked/failing features', icon: '🔺', keywords: 'escalation blocked', perform: () => setShowTriage(true) });
      cs.push({ id: 'insights', section: 'Control', title: 'Insights — analytics', icon: '📊', keywords: 'analytics histogram', perform: () => setActivePanel('insights') });
      cs.push({ id: 'hooks', section: 'Control', title: 'Hooks — edit pre/post lifecycle scripts', icon: '⚡', keywords: 'hook script pre post worker validator escalate', perform: () => setShowHooks(true) });
      cs.push({ id: 'intervene', section: 'Control', title: 'Intervene — send note to orchestrator', icon: '💬', keywords: 'note supervisor guidance', perform: () => setShowIntervention(true) });
      cs.push({ id: 'usage', section: 'Control', title: 'Usage — per-role cost breakdown', icon: '💵', keywords: 'cost tokens money spend', perform: () => setShowUsage(true) });
      cs.push({ id: 'snapshots', section: 'Control', title: 'Snapshots — rollback mission state', icon: '⟲', keywords: 'checkpoint rollback history restore', perform: () => setShowSnapshots(true) });
      cs.push({ id: 'decisions', section: 'Control', title: 'Decisions — orchestrator verb timeline', icon: '🧠', keywords: 'decision orchestrator verb ghost parser', perform: () => setShowDecisions(true) });
      cs.push({ id: 'smoke', section: 'Control', title: 'Smoke test — service gate (claudecode-orchestrator)', icon: '💨', keywords: 'smoke test gate service url check', perform: () => setShowSmokeTest(true) });
      cs.push({ id: 'identity', section: 'Control', title: 'Identity — cross-mission role memory (Agent-Swarm)', icon: '🧬', keywords: 'identity role memory cross mission learned patterns', perform: () => setShowIdentity(true) });
      cs.push({
        id: 'checkpoint-request', section: 'Control',
        title: 'Request checkpoint — pause harness for human approval',
        icon: '⏸', keywords: 'checkpoint pause hermes gate approval',
        perform: async () => {
          const name = typeof window !== 'undefined' ? window.prompt('Checkpoint name (letters/numbers/-_. only):', 'manual') : null;
          if (!name) return;
          const cleanName = name.replace(/[^A-Za-z0-9_.-]/g, '');
          if (!cleanName) { toast.error('invalid name'); return; }
          const message = typeof window !== 'undefined' ? window.prompt('Context message (optional):', '') : '';
          try {
            const r = await fetch(`/api/harness/${activeSlug}/checkpoint/${encodeURIComponent(cleanName)}/request`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: message ?? '' }),
            });
            const d = await r.json();
            if (d.ok) toast.success(`checkpoint "${cleanName}" requested`);
            else toast.error(`request failed: ${d.error ?? 'unknown'}`);
          } catch (e) { toast.error(String(e)); }
        },
      });
      cs.push({ id: 'screenshots', section: 'Control', title: 'Screenshots — visual history', icon: '📸', keywords: 'screenshot image visual capture', perform: () => setShowScreenshots(true) });
      cs.push({ id: 'newfeat', section: 'Control', title: 'Create new feature', icon: '＋', keywords: 'add feature', perform: () => setEditingFeature('new') });
      cs.push({ id: 'templates', section: 'Control', title: 'Start from template — seed SPEC.md + AGENTS.md', icon: '📋', keywords: 'template starter bootstrap spec', perform: () => setShowTemplates(true) });
      cs.push({ id: 'archives', section: 'Control', title: 'Archives — snapshot / restore mission state', icon: '📦', keywords: 'archive restore backup reset', perform: () => setShowArchives(true) });
      cs.push({
        id: 'supervisor', section: 'Control',
        title: 'Run supervisor — fresh review of mission',
        icon: '🧭', keywords: 'supervisor review check-in',
        perform: async () => {
          toast.info('Running supervisor…');
          try {
            const r = await fetch(`/api/harness/${activeSlug}/supervisor?phase=${activePhase}`, { method: 'POST' });
            const d = await r.json();
            if (d.ok) toast.success(`${d.outcome || 'supervisor complete'}`, { duration: 6000 });
            else toast.error(`supervisor failed: ${d.error ?? 'unknown'}`);
          } catch (e) { toast.error(String(e)); }
        },
      });
      cs.push({
        id: 'replan', section: 'Control',
        title: 'Re-plan — regenerate features + contract from SPEC.md',
        icon: '🔄', keywords: 'replan regenerate planner spec',
        perform: async () => {
          if (!confirm('Re-run the planner? Current features + contract will be backed up and replaced.')) return;
          toast.info('Re-planning… (may take a few minutes)');
          try {
            const r = await fetch(`/api/harness/${activeSlug}/replan?phase=${activePhase}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ overwrite: true }),
            });
            const d = await r.json();
            if (d.ok && d.produced) toast.success(`re-planned — backup at ${d.backupDir}`, { duration: 6000 });
            else toast.error(`replan: ${d.error ?? 'did not produce artifacts'}`);
            fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
          } catch (e) { toast.error(String(e)); }
        },
      });
    }
    for (const f of status?.features ?? []) {
      cs.push({
        id: `feat:${f.id}`, section: 'Features',
        title: `${f.id} · ${f.title}`,
        subtitle: `${f.status}${f.attempts ? ` · ${f.attempts} attempts` : ''}`,
        keywords: `${f.status} feature`,
        icon: '◇',
        perform: () => setPeekFeature(f),
      });
      cs.push({
        id: `diff:${f.id}`, section: 'Features',
        title: `${f.id} · view diff`,
        subtitle: `git diff main...papercusp/${f.id}`,
        keywords: `diff ${f.id} ${f.status}`,
        icon: '⎇',
        perform: () => setDiffFeatureId(f.id),
      });
    }
    for (const r of agents.slice(0, 20)) {
      cs.push({
        id: `run:${r.runId}`, section: 'Agent runs',
        title: `${r.role} · ${r.runId.slice(-20)}`,
        subtitle: new Date(r.ts).toLocaleString(),
        icon: '○',
        perform: () => loadAgent(r.runId),
      });
    }
    return cs;
  }, [projects, activeSlug, status, agents, launchHarness, stopHarness, loadAgent]);

  const triageCount = useMemo(
    () => (status?.features ?? []).filter((f) => f.status === 'blocked' || f.status === 'failing' || f.attempts >= 3).length,
    [status],
  );

  const activeProject = useMemo(
    () => projects.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );
  const activeProjectPath = status?.project.path ?? activeProject?.path ?? '';

  const activeLanes = useMemo(
    () => [...(lanes?.lanes ?? [])].filter((lane) => lane.alive).sort((a, b) => a.startedAt - b.startedAt),
    [lanes],
  );

  const isBrainstormPanel = activePanel === 'brainstorm';

  const recentAgentsContent = agents.length === 0 ? (
    <div className="h-empty">
      <Loader2 size={20} className="h-empty-icon h-spin" />
      <span>No agent runs yet.</span>
    </div>
  ) : (
    <RecentAgentsTable agents={agents} onSelect={loadAgent} />
  );

  return (
    <div className={`h-root${isBrainstormPanel ? ' brainstorm-mode' : ''}`}>
      <Toaster theme="dark" position="bottom-right" richColors />

      {/* ── Mission header ─────────────────────────────────── */}
      <div className={`h-header${status?.alive ? ' alive' : ''}`}>
        <div className="h-header-main">

          <div className="h-project-card">
            <div className="h-project-topline">
              <span className="h-project-label">Project</span>
              {status && (
                <span className={`h-status-chip ${status.alive ? 'live' : 'idle'}`}>
                  <span className={`h-pulse-dot ${status.alive ? 'live' : 'idle'}`} />
                  {status.alive ? 'running' : 'idle'}
                </span>
              )}
            </div>
            <select
              className="h-project"
              aria-label="Select harness project"
              value={activeSlug ?? ''}
              onChange={(e) => setActiveSlug(e.target.value)}
            >
              <option value="">— pick a project —</option>
              {/* Layer 3-E: group by harness_kind so the org/department hierarchy is visible. */}
              {(['org', 'department', 'coding'] as const).map((kind) => {
                const kindProjects = projects.filter((p) => ((p as any).harness_kind ?? 'coding') === kind);
                if (kindProjects.length === 0) return null;
                const labels: Record<typeof kind, string> = {
                  org: 'Org (parent harnesses)',
                  department: 'Departments (children)',
                  coding: 'Coding projects',
                } as const;
                return (
                  <optgroup key={kind} label={labels[kind]}>
                    {kindProjects.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.slug} {p.hasState ? '' : '(no state)'}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <div className="h-project-meta">
              <span className="h-project-path">
                {activeProjectPath || 'Choose a workspace to view agents, logs, issues, docs, and VSCode.'}
              </span>
              {status && <span className="h-project-progress">{progressPct}% complete</span>}
            </div>
            {status && (
              <div className="h-progress-rail" aria-label={`Mission progress ${progressPct}%`}>
                <span style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>
        </div>

        {status ? (
          <div className="h-header-side">
            <div className="h-stats">
              <StatCard
                label="iter"
                value={status.iteration}
                icon={<Activity size={13} />}
              />
              <StatCard
                label="passed"
                value={`${passedCount}/${totalCount}`}
                tone={progressPct === 100 ? 'good' : undefined}
                icon={<CheckCircle2 size={13} />}
              />
              {typeof status.missionCostUsd === 'number' && status.missionCostUsd > 0 && (
                <button
                  className="h-stat-button"
                  onClick={() => setShowUsage(true)}
                  title="Open per-role cost breakdown"
                >
                  <StatCard
                    label="spent"
                    value={`${status.missionCostUsd.toFixed(2)}`}
                    icon={<Coins size={13} />}
                  />
                </button>
              )}
              {activeSlug && <HealthBadge slug={activeSlug} />}
              {typeof status.pendingCheckpoints === 'number' && status.pendingCheckpoints > 0 && (
                <div title={`${status.pendingCheckpoints} checkpoint${status.pendingCheckpoints === 1 ? '' : 's'} awaiting grant`}>
                  <StatCard
                    label="checkpoints"
                    value={`${status.pendingCheckpoints} pending`}
                    tone="warn"
                    icon={<AlertTriangle size={13} />}
                  />
                </div>
              )}
              {typeof status.activeCompetitions === 'number' && status.activeCompetitions > 0 && (
                <div title={`${status.activeCompetitions} competition${status.activeCompetitions === 1 ? '' : 's'} in progress`}>
                  <StatCard
                    label="competitions"
                    value={String(status.activeCompetitions)}
                  />
                </div>
              )}
              {status.smokeFail && (
                <button
                  className="h-stat-button"
                  onClick={() => setShowSmokeTest(true)}
                  title="Last smoke test failed — click to view"
                >
                  <StatCard label="smoke" value="FAIL" tone="bad" />
                </button>
              )}
              {lanes && (lanes.max > 1 || lanes.lanes.filter((l) => l.alive).length > 0) && (() => {
                const alive = lanes.lanes.filter((l) => l.alive);
                const title = alive.length > 0
                  ? `Active lanes:\n${alive.map((l) => `  ${l.featureId} · ${l.elapsedSeconds}s`).join('\n')}`
                  : 'No active lanes';
                return (
                  <div title={title}>
                    <StatCard
                      label="lanes"
                      value={`${alive.length}/${lanes.max}`}
                      tone={alive.length === lanes.max && lanes.max > 1 ? 'good' : undefined}
                    />
                  </div>
                );
              })()}
              {status.lastDecision && (
                <StatCard
                  label="decision"
                  value={<span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{status.lastDecision}</span>}
                  icon={<ArrowRight size={13} />}
                />
              )}
            </div>

            <div className="h-header-actions">
              {status.escalated && (
                <span className="h-escalated-pill">
                  <AlertTriangle size={12} /> escalated
                </span>
              )}
              <button className="h-btn ghost h-key-btn" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
                ⌘K
              </button>
              <button
                className={`h-btn ${triageCount > 0 ? 'danger' : 'ghost'}`}
                onClick={() => setShowTriage(true)}
                title="Triage — features needing attention"
              >
                <AlertTriangle size={13} /> triage{triageCount > 0 ? ` · ${triageCount}` : ''}
              </button>
              {status.alive ? (
                <button className="h-btn danger" onClick={stopHarness}>
                  <Square size={13} fill="currentColor" /> stop
                </button>
              ) : (
                <button className="h-btn primary" onClick={launchHarness}>
                  <Play size={13} fill="currentColor" /> start
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="h-header-empty">
            <span>Pick a project, then use <strong>⌘K</strong> for every harness action.</span>
          </div>
        )}
      </div>

      {activeSlug && (
        <PhaseTabs slug={activeSlug} activePhase={activePhase} onChange={setActivePhase} />
      )}

      {activeSlug && status && (
        <EscalationBanner
          slug={activeSlug}
          escalated={status.escalated}
          onResumed={() => {
            fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
          }}
        />
      )}

      {activeSlug && <PlanReviewBanner slug={activeSlug} />}
      {activeSlug && <CheckpointBanner slug={activeSlug} />}

      {activeSlug && status && !isBrainstormPanel && (
        <PulseFeed
          events={pulseEvents}
          onOpenFeature={(id) => {
            const f = status.features.find((ff) => ff.id === id);
            if (f) setPeekFeature(f);
          }}
        />
      )}

      {activeSlug && status && !isBrainstormPanel && (
        <div className={`h-mission-overview ${triageCount > 0 ? 'has-action' : ''}`} aria-label="Mission overview">
          <button
            className={`h-focus-card ${focusFeature?.status ?? 'empty'}`}
            onClick={() => { if (focusFeature) setPeekFeature(focusFeature); }}
            disabled={!focusFeature}
            title={focusFeature ? `Open ${focusFeature.id}` : 'No focus feature yet'}
          >
            <span className="h-overline">Mission focus</span>
            <strong>{focusFeature ? focusVerb(focusFeature.status) : 'Waiting for planner'}</strong>
            <span className="h-focus-title">
              {focusFeature ? `${focusFeature.id} · ${focusFeature.title}` : 'Features will appear here once planning starts.'}
            </span>
          </button>

          <div className="h-status-distribution">
            <div className="h-status-rail" aria-label="Feature status distribution">
              {statusSummary.length > 0 ? statusSummary.map((entry) => (
                <span
                  key={entry.status}
                  className={`h-status-segment ${entry.status}`}
                  style={{ flexGrow: entry.count }}
                  title={`${entry.count} ${entry.label}`}
                />
              )) : <span className="h-status-segment empty" />}
            </div>
            <div className="h-status-legend">
              {statusSummary.length > 0 ? statusSummary.map((entry) => (
                <span key={entry.status} className={`h-status-token ${entry.status}`}>
                  <span /> {entry.label} <strong>{entry.count}</strong>
                </span>
              )) : <span className="h-status-token empty">no features yet</span>}
            </div>
          </div>

          {triageCount > 0 && (
            <button
              className="h-overview-action warn"
              onClick={() => setShowTriage(true)}
            >
              Review {triageCount} issue{triageCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {activeSlug && status && lanes && !isBrainstormPanel && (
        <div className="h-running-strip" aria-label="Now running lanes">
          <div className="h-running-head">
            <span>Now running</span>
            <strong>{activeLanes.length}/{lanes.max}</strong>
          </div>
          <div className="h-running-lanes">
            {Array.from({ length: Math.max(lanes.max, activeLanes.length, 1) }).map((_, index) => {
              const lane = activeLanes[index];
              if (!lane) {
                return <span key={`idle-${index}`} className="h-running-lane idle">available lane</span>;
              }
              const feature = status.features.find((f) => f.id === lane.featureId);
              return (
                <button
                  key={`${lane.pid}-${lane.featureId}`}
                  className="h-running-lane live"
                  onClick={() => { if (feature) setPeekFeature(feature); }}
                  title={`PID ${lane.pid} · ${lane.featureId}`}
                >
                  <span className="h-running-dot" />
                  <span className="h-running-id">{lane.featureId}</span>
                  <span className="h-running-title">{feature?.title ?? 'working'}</span>
                  <span className="h-running-time">{fmtDuration(lane.elapsedSeconds)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Main-area tab switcher ─────────────────────────────── */}
      <div className="h-tabs h-main-tabs" role="tablist" aria-label="Harness workspace sections">
        <button
          className={`h-tab h-tab--brainstorm${activePanel === 'brainstorm' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'brainstorm'}
          onClick={() => activeSlug && setActivePanel('brainstorm')}
          disabled={!activeSlug}
          title={activeSlug ? 'Brainstorm — write, mindmap, canvas, chat with Claude' : 'Select a project to brainstorm'}
        >
          <Lightbulb size={13} /> brainstorm
        </button>
        <button
          className={`h-tab h-tab--proposals${activePanel === 'proposals' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'proposals'}
          onClick={() => activeSlug && setActivePanel('proposals')}
          disabled={!activeSlug}
          title={activeSlug ? `Product proposals — scope expansion from SPEC.md${pendingProposals > 0 ? ` · ${pendingProposals} pending` : ''}` : 'Select a project to view proposals'}
        >
          🪄 proposals
          {pendingProposals > 0 && <span className="h-tab-count">{pendingProposals}</span>}
        </button>
        <button
          className={`h-tab h-tab--dashboard${activePanel === 'dashboard' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'dashboard'}
          onClick={() => setActivePanel('dashboard')}
          title="Harness dashboard — feature queue, agents, logs, issues"
        >
          <LayoutDashboard size={13} /> dashboard
        </button>
        <button
          className={`h-tab h-tab--summary${activePanel === 'summary' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'summary'}
          onClick={() => setActivePanel('summary')}
          title={activeSlug ? 'Project summary — high-level changelog of what has been built' : 'Select a project to view summary'}
        >
          <FileText size={13} /> summary
        </button>
        <button
          className={`h-tab h-tab--docs${activePanel === 'docs' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'docs'}
          onClick={() => setActivePanel('docs')}
          title={activeSlug ? 'Project docs (requires docs-viewer on :4325)' : 'Select a project to view docs'}
        >
          <BookOpen size={13} /> docs
        </button>
        <button
          className={`h-tab h-tab--vscode${activePanel === 'vscode' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'vscode'}
          onClick={() => setActivePanel('vscode')}
          title={activeSlug ? 'code-server — edit project in VSCode' : 'Select a project to open in VSCode'}
        >
          <Code2 size={13} /> vscode
        </button>
        <button
          className={`h-tab h-tab--insights${activePanel === 'insights' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'insights'}
          onClick={() => setActivePanel('insights')}
          title={activeSlug ? 'Insights — analytics' : 'Select a project to view insights'}
        >
          <TrendingUp size={13} /> insights
        </button>
        <button
          className={`h-tab h-tab--config${activePanel === 'config' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'config'}
          onClick={() => setActivePanel('config')}
          title={activeSlug ? 'Edit SPEC.md / AGENTS.md / config.json' : 'Select a project to edit config'}
        >
          <SlidersHorizontal size={13} /> config
        </button>
        <button
          className={`h-tab h-tab--plugin${activePanel === 'plugins' ? ' on' : ''}`}
          role="tab"
          aria-selected={activePanel === 'plugins'}
          onClick={() => setActivePanel('plugins')}
          title={activeSlug ? 'Plugin-contributed dashboard tabs' : 'Select a project to view plugin tabs'}
        >
          🧩 plugins
        </button>
      </div>

      {!status && (
        <div className="h-guide-strip">
          {activeSlug ? <Loader2 size={14} className="h-spin" /> : <Activity size={14} />}
          <span>{activeSlug ? `Loading ${activeSlug} mission state…` : 'Pick a project to unlock docs, VSCode, logs, issues, and agent controls.'}</span>
          <button className="h-guide-action" onClick={() => setPaletteOpen(true)}>Open commands</button>
        </div>
      )}

      {/* ── Main area ──────────────────────────────────────────── */}
      <div className={`h-main-shell ${activePanel === 'dashboard' ? 'dashboard' : activePanel === 'brainstorm' ? 'brainstorm-full' : 'embed'}`}>
        {activePanel === 'brainstorm' && activeSlug && (
          <BrainstormFull slug={activeSlug} />
        )}
        {activePanel === 'proposals' && activeSlug && (
          <ProposalsPanel slug={activeSlug} />
        )}
        {activePanel === 'summary' && activeSlug && (
          <SummaryPanel
            slug={activeSlug}
            onOpenFeature={(fid) => {
              const f = status?.features.find((ff) => ff.id === fid);
              if (f) {
                setPeekFeature(f);
              } else {
                setActivePanel('dashboard');
              }
            }}
          />
        )}
        {activePanel === 'docs' && activeSlug && (
          <iframe
            src={docsUrl(activeSlug)}
            title="Project docs"
            style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
          />
        )}
        {activePanel === 'vscode' && activeSlug && status && (
          <iframe
            src={vscodeUrl(status.project.path)}
            title="VSCode"
            style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: 'var(--bg-2)' }}
          />
        )}
        {activePanel === 'insights' && status && (
          <InsightsPanel
            inline
            features={status.features as any}
            totalCostUsd={status.missionCostUsd ?? 0}
            totalInputTokens={status.missionInputTokens ?? 0}
            totalOutputTokens={status.missionOutputTokens ?? 0}
            iteration={status.iteration}
            onClose={() => setActivePanel('dashboard')}
          />
        )}
        {activePanel === 'config' && activeSlug && status && (
          <SpecEditor
            inline
            slug={activeSlug}
            projectPath={status.project.path}
            alive={status.alive}
            onClose={() => setActivePanel('dashboard')}
          />
        )}
        {activePanel === 'plugins' && activeSlug && (
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            <PluginTabs slug={activeSlug} />
          </div>
        )}
        {!activeSlug && (activePanel === 'summary' || activePanel === 'docs' || activePanel === 'vscode' || activePanel === 'config' || activePanel === 'insights' || activePanel === 'brainstorm' || activePanel === 'proposals' || activePanel === 'plugins') && (
          <div className="h-empty" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Activity size={18} className="h-empty-icon" />
            <span>Pick a project above to view {activePanel}.</span>
          </div>
        )}
        {activeSlug && !status && (activePanel === 'vscode' || activePanel === 'config') && (
          <div className="h-empty" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader2 size={18} className="h-empty-icon h-spin" />
            <span>Loading {activeSlug} mission state…</span>
          </div>
        )}
        {activePanel === 'dashboard' && (
          <>
            {isCompact ? (
            <div className="h-compact-dashboard">
              <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" tabIndex={-1}>
                <Panel title="Feature queue" count={totalCount}>
                <FeatureList
                  features={(status?.features ?? []) as any}
                  activeFeatureId={peekFeature?.id ?? null}
                  onSelect={(f) => setPeekFeature(f as Feature)}
                  onReset={resetFeature}
                  onAdd={() => setEditingFeature('new')}
                  onBatchReset={batchReset}
                  onBatchDelete={batchDelete}
                />
              </Panel>
              </div>

              {activeSlug && (
                <div className="h-compact-panel h-compact-inbox h-dashboard-panel-anchor" data-dashboard-panel={leftPane} tabIndex={-1}>
                  <LeftPaneTabs leftPane={leftPane} setLeftPane={setLeftPane} />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {leftPane === 'inbox' && (
                      <ArchitectInbox
                        slug={activeSlug}
                        onFeatureFocus={(fid) => {
                          const f = status?.features.find((ff) => ff.id === fid);
                          if (f) setPeekFeature(f);
                        }}
                      />
                    )}
                    {leftPane === 'git' && <GitGraphPanel slug={activeSlug} />}
                  </div>
                </div>
              )}

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" tabIndex={-1}>
                <Panel title="Recent agents" count={agents.length}>
                {recentAgentsContent}
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" tabIndex={-1}>
                <Panel title="run.log" count="live">
                <LogView lines={logLines} />
              </Panel>
              </div>

              <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" tabIndex={-1}>
                <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
              </div>
            </div>
          ) : (
        <div className="h-dashboard-grid" style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0, flex: 1 }}>
          {activeSlug && leftPane === 'inbox' && (
            <CollapsedGitRail slug={activeSlug} onExpand={() => setLeftPane('git')} />
          )}
          {activeSlug && leftPane === 'git' && (
            <CollapsedInboxRail slug={activeSlug} onExpand={() => setLeftPane('inbox')} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
        <PanelGroup orientation="horizontal">
          {activeSlug && (
            <>
              <RPanel key={leftPane} defaultSize={leftPane === 'git' ? '30%' : '26%'} minSize={leftPane === 'git' ? '20%' : '18%'} maxSize={leftPane === 'git' ? '48%' : '42%'}>
                <div className="h-dashboard-panel-anchor h-dashboard-left-pane" data-dashboard-panel={leftPane} tabIndex={-1} style={{
                  height: '100%',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}>
                  <LeftPaneTabs leftPane={leftPane} setLeftPane={setLeftPane} />
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {leftPane === 'inbox' && (
                      <ArchitectInbox
                        slug={activeSlug}
                        onFeatureFocus={(fid) => {
                          const f = status?.features.find((ff) => ff.id === fid);
                          if (f) setPeekFeature(f);
                        }}
                      />
                    )}
                    {leftPane === 'git' && <GitGraphPanel slug={activeSlug} />}
                  </div>
                </div>
              </RPanel>
              <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
            </>
          )}
          <RPanel defaultSize="82%">
            <PanelGroup orientation="vertical">
              {/* Top: Feature queue, full width */}
              <RPanel defaultSize="40%" minSize="20%">
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="features" tabIndex={-1}>
                  <Panel title="Feature queue" count={totalCount}>
                    <FeatureList
                      features={(status?.features ?? []) as any}
                      activeFeatureId={peekFeature?.id ?? null}
                      onSelect={(f) => setPeekFeature(f as Feature)}
                      onReset={resetFeature}
                      onAdd={() => setEditingFeature('new')}
                      onBatchReset={batchReset}
                      onBatchDelete={batchDelete}
                    />
                  </Panel>
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Middle: Issues / Tests / Report tabs, full width */}
              <RPanel defaultSize="35%" minSize="20%">
                <div className="h-dashboard-panel-anchor" data-dashboard-panel="issues" tabIndex={-1}>
                  <IssuesPanel slug={activeSlug ?? ''} reportMd={issues} phase={activePhase} />
                </div>
              </RPanel>
              <Separator className="h-resize-v" style={{ margin: '6px 0' }} />
              {/* Bottom row: Recent agents + run.log side-by-side, compact */}
              <RPanel defaultSize="25%" minSize="12%">
                <PanelGroup orientation="horizontal">
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="agents" tabIndex={-1}>
                      <Panel title="Recent agents" count={agents.length}>
                        {recentAgentsContent}
                      </Panel>
                    </div>
                  </RPanel>
                  <Separator className="h-resize-h" style={{ margin: '0 6px' }} />
                  <RPanel defaultSize="50%" minSize="20%">
                    <div className="h-dashboard-panel-anchor" data-dashboard-panel="logs" tabIndex={-1}>
                      <Panel title="run.log" count="live">
                        <LogView lines={logLines} />
                      </Panel>
                    </div>
                  </RPanel>
                </PanelGroup>
              </RPanel>
            </PanelGroup>
          </RPanel>
        </PanelGroup>
          </div>
        </div>
          )}
          </>
        )}
      </div>

      {/* ── Command palette (⌘K) ──────────────────────────── */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      {/* ── Feature peek panel ────────────────────────────── */}
      {peekFeature && (
        <FeaturePeekPanel
          slug={activeSlug ?? ''}
          feature={peekFeature as any}
          agents={agents as any}
          issues={issues}
          onClose={() => setPeekFeature(null)}
          onReset={resetFeature}
          onEdit={() => { setEditingFeature(peekFeature); setPeekFeature(null); }}
          onInspectRun={loadAgent}
          onSetStatus={(id, s) => setFeatureStatus(id, s as FeatureStatus)}
        />
      )}

      {/* ── Triage queue ──────────────────────────────────── */}
      {showTriage && status && (
        <TriageQueue
          features={status.features as any}
          issues={issues}
          onClose={() => setShowTriage(false)}
          onOpenFeature={(id) => {
            const f = status.features.find((ff) => ff.id === id);
            if (f) { setPeekFeature(f); setShowTriage(false); }
          }}
          onReset={(id) => { resetFeature(id); }}
          onUnblock={(id) => setFeatureStatus(id, 'todo')}
          onSkip={(id) => setFeatureStatus(id, 'passed')}
        />
      )}

      {/* ── Agent inspector modal ─────────────────────────── */}
      {selectedAgent && (
        <AgentInspector
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onRefresh={() => loadAgent(selectedAgent.runId)}
        />
      )}

      {/* ── Hooks panel ───────────────────────────────────── */}
      {showHooks && activeSlug && status && (
        <div data-harness-modal="true">
          <HooksPanel
            slug={activeSlug}
            alive={status.alive}
            onClose={() => setShowHooks(false)}
          />
        </div>
      )}

      {/* ── Intervention panel ────────────────────────────── */}
      {showIntervention && activeSlug && status && (
        <div data-harness-modal="true">
          <InterventionPanel
            slug={activeSlug}
            alive={status.alive}
            onClose={() => setShowIntervention(false)}
          />
        </div>
      )}

      {/* ── Usage panel ───────────────────────────────────── */}
      {showUsage && activeSlug && (
        <div data-harness-modal="true">
          <UsagePanel
            slug={activeSlug}
            onClose={() => setShowUsage(false)}
          />
        </div>
      )}

      {/* ── Snapshots panel ───────────────────────────────── */}
      {showSnapshots && activeSlug && (
        <div data-harness-modal="true">
          <SnapshotsPanel
            slug={activeSlug}
            onClose={() => setShowSnapshots(false)}
            onRestored={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Screenshots panel ─────────────────────────────── */}
      {showScreenshots && activeSlug && (
        <div data-harness-modal="true">
          <ScreenshotsPanel
            slug={activeSlug}
            onClose={() => setShowScreenshots(false)}
          />
        </div>
      )}

      {/* ── Decisions panel ───────────────────────────────── */}
      {showDecisions && activeSlug && (
        <div data-harness-modal="true">
          <DecisionsPanel
            slug={activeSlug}
            onClose={() => setShowDecisions(false)}
          />
        </div>
      )}

      {/* ── Smoke test panel ──────────────────────────────── */}
      {showSmokeTest && activeSlug && (
        <div data-harness-modal="true">
          <SmokeTestPanel
            slug={activeSlug}
            onClose={() => setShowSmokeTest(false)}
          />
        </div>
      )}

      {/* ── Identity panel ────────────────────────────────── */}
      {showIdentity && (
        <div data-harness-modal="true">
          <IdentityPanel onClose={() => setShowIdentity(false)} />
        </div>
      )}

      {/* ── Feature diff modal ────────────────────────────── */}
      {diffFeatureId && activeSlug && (
        <div data-harness-modal="true">
          <FeatureDiffModal
            slug={activeSlug}
            featureId={diffFeatureId}
            onClose={() => setDiffFeatureId(null)}
          />
        </div>
      )}

      {/* ── Archives panel ────────────────────────────────── */}
      {showArchives && activeSlug && (
        <div data-harness-modal="true">
          <ArchivesPanel
            slug={activeSlug}
            onClose={() => setShowArchives(false)}
            onChanged={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Templates modal ───────────────────────────────── */}
      {showTemplates && activeSlug && (
        <div data-harness-modal="true">
          <TemplatesModal
            slug={activeSlug}
            onClose={() => setShowTemplates(false)}
            onBootstrapped={() => {
              // SPEC.md content may have changed; refetch spec + status
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}

      {/* ── Feature editor modal ──────────────────────────── */}
      {editingFeature !== null && activeSlug && (
        <div data-harness-modal="true">
          <FeatureEditor
            slug={activeSlug}
            feature={editingFeature === 'new' ? null : editingFeature}
            onClose={() => setEditingFeature(null)}
            onSaved={() => {
              fetch(`/api/harness/${activeSlug}/status?phase=${activePhase}`).then((r) => r.json()).then(setStatus).catch(() => {});
            }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Recent agents table ──────────────────────────────────────────────

function roleClass(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function RecentAgentsTable({
  agents, onSelect,
}: {
  agents: AgentRun[];
  onSelect: (runId: string) => void;
}) {
  return (
    <table className="h-agent-table">
      <thead>
        <tr>
          <th>when</th>
          <th>role</th>
          <th>run id</th>
          <th className="right">size</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((r) => {
          const cls = roleClass(r.role);
          return (
            <tr
              key={r.runId}
              className={`h-agent-row role-${cls}`}
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${r.role} run ${r.runId}`}
              onClick={() => onSelect(r.runId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(r.runId);
                }
              }}
            >
              <td className="h-agent-time-cell nowrap">
                <span className="h-agent-dot" aria-hidden="true" />
                <span>{fmtAgo(r.ts)}</span>
              </td>
              <td className="h-agent-role-cell">
                <span className={`h-agent-role ${cls}`}>{r.role}</span>
              </td>
              <td className="h-agent-run-cell mono runid" title={r.runId}>{r.runId.slice(0, 14)}…</td>
              <td className="h-agent-size-cell muted mono right">{fmtBytes(r.sizeBytes)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}


// ─── Left pane tab selector (inbox / git) ──────────
function LeftPaneTabs({
  leftPane,
  setLeftPane,
}: {
  leftPane: 'inbox' | 'git';
  setLeftPane: (p: 'inbox' | 'git') => void;
}) {
  const tabs: Array<{ id: 'inbox' | 'git'; label: string }> = [
    { id: 'inbox', label: 'inbox' },
    { id: 'git', label: 'git' },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '4px 6px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg-2)',
      flexShrink: 0,
    }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setLeftPane(t.id)}
          style={{
            padding: '4px 10px',
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: leftPane === t.id ? 'var(--fg)' : 'var(--fg-dim)',
            background: leftPane === t.id ? 'var(--bg-3)' : 'transparent',
            border: `1px solid ${leftPane === t.id ? 'var(--border)' : 'transparent'}`,
            borderRadius: 4,
            cursor: 'pointer',
            transition: 'all 120ms ease',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Tabbed Issues panel ──────────────────────────────────────────

function IssuesPanel({ slug, reportMd, phase }: { slug: string; reportMd: string; phase: Phase }) {
  const [tab, setTab] = useState<'issues' | 'report' | 'tests'>('issues');
  const [issueCount, setIssueCount] = useState<number | null>(null);

  return (
    <div className="h-panel" style={{ height: '100%' }}>
      <div className="h-tabs">
        <button
          className={`h-tab${tab === 'issues' ? ' on' : ''}`}
          onClick={() => setTab('issues')}
        >
          issues
          {issueCount !== null && <span className="h-tab-count">{issueCount}</span>}
        </button>
        <button
          className={`h-tab${tab === 'tests' ? ' on' : ''}`}
          onClick={() => setTab('tests')}
        >
          tests
        </button>
        <button
          className={`h-tab${tab === 'report' ? ' on' : ''}`}
          onClick={() => setTab('report')}
        >
          report
          {reportMd && <span className="h-tab-count">{reportMd.length > 0 ? 'md' : ''}</span>}
        </button>
      </div>
      <div className="h-panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
        {tab === 'issues' && <IssuesList slug={slug} onCount={setIssueCount} />}
        {tab === 'tests' && <TestsTab slug={slug} phase={phase} />}
        {tab === 'report' && <MarkdownView source={reportMd} />}
      </div>
    </div>
  );
}

// ─── Agent inspector ──────────────────────────────────────────────

function AgentInspector({
  agent, onClose, onRefresh,
}: {
  agent: AgentDetail;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const done = agent.timeline.some((e) => e.kind === 'result');
  const lastResult = agent.timeline.findLast?.((e) => e.kind === 'result');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          width: '90vw', height: '86vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--fg)' }}>{agent.runId}</span>
          <span className={`h-pill ${done ? 'passed' : 'in_progress'}`}>
            <span className="h-pill-dot" />
            {done ? 'complete' : 'streaming'}
          </span>
          {agent.totalCostUsd > 0 && (
            <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              ${agent.totalCostUsd.toFixed(4)}
              {agent.totalInputTokens ? <> · {agent.totalInputTokens.toLocaleString()}in / {agent.totalOutputTokens.toLocaleString()}out</> : null}
              {lastResult?.durationMs ? <> · {(lastResult.durationMs / 1000).toFixed(1)}s</> : null}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="h-btn ghost" onClick={onRefresh}><RotateCcw size={12} /> refresh</button>
            <button className="h-btn ghost" onClick={onClose}>close</button>
          </div>
        </div>
        {agent.timeline.length === 0 && (
          <div className="h-empty"><Loader2 size={18} className="h-empty-icon" style={{ animation: 'spin 1s linear infinite' }} /><span>Waiting for first event…</span></div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
          {agent.timeline.map((e, i) => <TimelineBlock key={i} entry={e} />)}
        </div>
        {agent.stderr && agent.stderr.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', padding: 10, maxHeight: '18vh', overflow: 'auto' }}>
            <div style={{ fontSize: 11, color: 'var(--bad)', fontWeight: 600, marginBottom: 4 }}>stderr ({agent.stderr.length} chars)</div>
            <pre style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', color: 'color-mix(in oklab, var(--bad), white 30%)', whiteSpace: 'pre-wrap', margin: 0 }}>{agent.stderr}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineBlock({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'text') {
    return <div className="h-tl-block text">{entry.text}</div>;
  }
  if (entry.kind === 'tool_use') {
    return (
      <div className="h-tl-block tool">
        <div className="h-tl-tag"><Wrench size={10} /> {entry.toolName}</div>
        <JsonTree data={entry.toolInput} />
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    const text = entry.text ?? '';
    // Heuristic: if it looks like JSON, tree-view it; otherwise show as text
    const trimmed = text.trim();
    const isJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    return (
      <div className="h-tl-block result">
        <div className="h-tl-tag"><ArrowRight size={10} /> tool result</div>
        {isJson ? <JsonTree data={trimmed} /> : (
          <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--fg)' }}>{text.slice(0, 4000)}{text.length > 4000 ? '…' : ''}</div>
        )}
      </div>
    );
  }
  if (entry.kind === 'result') {
    return (
      <div className="h-tl-block result">
        <div className="h-tl-tag"><CheckCircle2 size={10} /> final result {entry.costUsd != null && <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>· ${entry.costUsd.toFixed(4)}</span>}</div>
        <div>{entry.text}</div>
      </div>
    );
  }
  if (entry.kind === 'status') {
    return <div className="h-tl-block status">· {entry.text}</div>;
  }
  if (entry.kind === 'error') {
    return (
      <div className="h-tl-block error">
        <div className="h-tl-tag"><AlertTriangle size={10} /> error</div>
        <div>{entry.text}</div>
      </div>
    );
  }
  return null;
}
