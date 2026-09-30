'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { Button } from '../../../harness/Button';
import { Checkbox } from '../../../harness/Checkbox';
import { Select } from '../../../harness/Select';
import RouteLink from '@/app/_components/RouteLink';
import {
  type AdminTestCheckResult,
  type AdminTestRunSnapshot,
} from '@papercusp/operator-core/lib/admin-test-suites-shared';

interface HealthPayload {
  pgvector: boolean;
  mem0_ready: boolean;
  embedder_mode: 'openai' | 'local' | 'disabled' | null;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
  entry_count_user: number | null;
  entry_count_workspace_shared: number | null;
  recent_feedback_24h: number;
  blocking_reason: string | null;
}

interface CheckCatalog {
  checks: Array<{ id: string; label: string }>;
}

type ProbeAction = 'remember' | 'search' | 'list' | 'forget' | 'update';

interface ProbeResponse {
  ok: boolean;
  reason?: string;
  error?: string;
  result?: unknown;
  results?: Array<{ id: string; memory?: string; metadata?: Record<string, unknown>; score?: number }>;
}

const HEALTH_POLL_MS = 5_000;
const RUN_POLL_MS = 1_000;

export default function MemoryTab() {
  const [selectedCheck, setSelectedCheck] = useQueryState('check', parseAsString);
  const [probeAction, setProbeAction] = useQueryState(
    'probe',
    parseAsStringEnum<ProbeAction>(['remember', 'search', 'list', 'forget', 'update']).withDefault('remember'),
  );

  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [preflight, setPreflight] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [catalog, setCatalog] = useState<CheckCatalog | null>(null);
  const [runId, setRunId] = useQueryState('run', parseAsString);
  const [snapshot, setSnapshot] = useState<AdminTestRunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);

  // Live health strip — poll every 5s while the tab is visible.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const [h, p] = await Promise.all([
          fetch('/api/admin/testing/memory/health', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/admin/testing/memory/preflight', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setHealth(h);
        setPreflight(p);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(tick, HEALTH_POLL_MS);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  // Check catalog — static, fetched once.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/admin/testing/memory/checks', { cache: 'no-store' })
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  // Run snapshot polling.
  const refreshSnapshot = useCallback(async (id: string) => {
    const r = await fetch(`/api/admin/testing/test-runs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (r.status === 404) { setRunId(null); setSnapshot(null); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setSnapshot((await r.json()) as AdminTestRunSnapshot);
  }, [setRunId]);

  useEffect(() => {
    if (!runId) { setSnapshot(null); return; }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try { await refreshSnapshot(runId); }
      catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void tick();
    if (!snapshot || snapshot.status === 'running') {
      interval = setInterval(() => { void tick(); }, RUN_POLL_MS);
    }
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [refreshSnapshot, runId, snapshot]);

  const startRun = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/testing/test-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suiteId: 'memory-core', returnHref: window.location.href }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as { runId: string; snapshot: AdminTestRunSnapshot };
      setRunId(data.runId);
      setSnapshot(data.snapshot);
      setSelectedCheck(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [setRunId, setSelectedCheck]);

  const cancelRun = useCallback(async () => {
    if (!runId) return;
    try {
      const r = await fetch(`/api/admin/testing/test-runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { ok: true; snapshot: AdminTestRunSnapshot };
      setSnapshot(data.snapshot);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  const memoryResults: AdminTestCheckResult[] = useMemo(() => {
    return (snapshot?.results ?? []).filter((r) => r.suiteId === 'memory-core');
  }, [snapshot]);

  const running = snapshot?.status === 'running';
  const blocked = preflight !== null && !preflight.ok;

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Memory system</h1>
          <p className="pc-test-tab-intro">
            mem0-backed persistent memory: pgvector store, OpenAI / local embedder,
            Anthropic-Haiku fact extraction, per-user + workspace-shared scoping,
            TTL cleanup, pre-turn injection. Health strip below polls every 5s; the
            test suite is the same as <code>test-runs</code> &rarr; <code>memory-core</code>.
            Plan: <code>apps/operator/docs/plans/operator-arc-2026-05-12.md</code> (Plan 3).
          </p>
        </div>
      </header>

      <HealthStrip health={health} />

      {blocked && preflight ? (
        <div className="pc-warn" role="alert" style={{ margin: '12px 0' }}>
          <strong>Suite blocked.</strong>
          <span>{preflight.reason ?? 'Embedder unavailable.'}</span>
          <RouteLink href="/settings/api-keys" style={{ marginLeft: 12 }}>Open API keys settings</RouteLink>
        </div>
      ) : null}

      <section className="pc-test-section" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => void startRun()} disabled={running || blocked}>
            {running ? 'Running…' : 'Run memory suite'}
          </Button>
          {running ? (
            <Button variant="ghost" onClick={() => void cancelRun()}>Cancel</Button>
          ) : null}
          <span className="pc-test-tab-hint">
            {snapshot
              ? `Run ${snapshot.runId} · status ${snapshot.status}`
              : 'No run started this session.'}
          </span>
        </div>
        {error ? (
          <div className="pc-warn" role="alert" style={{ marginTop: 8 }}>
            <strong>Error.</strong><span>{error}</span>
          </div>
        ) : null}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1fr) 2fr', gap: 16, marginTop: 16 }}>
        <CheckList
          catalog={catalog?.checks ?? []}
          results={memoryResults}
          progressId={snapshot?.progressBySuite?.['memory-core']?.checkId ?? null}
          selectedId={selectedCheck}
          onSelect={(id) => setSelectedCheck(id)}
        />
        <CheckDetail
          checkId={selectedCheck}
          result={memoryResults.find((r) => r.id === selectedCheck) ?? null}
        />
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 className="pc-test-section-label">Manual probes</h2>
        <p className="pc-test-tab-hint" style={{ marginBottom: 8 }}>
          Calls run against the current session user (NOT the synthetic test users).
          Useful for reproducing a suite failure or sanity-checking after a config change.
        </p>
        <nav className="pc-test-subnav" aria-label="Probe actions">
          {(['remember', 'search', 'list', 'forget', 'update'] as const).map((a) => (
            <Button key={a} variant={probeAction === a ? 'primary' : 'ghost'} onClick={() => setProbeAction(a)}>
              {a}
            </Button>
          ))}
        </nav>
        <ProbePanel
          action={probeAction}
          busy={probeBusy}
          onSubmit={async (payload) => {
            setProbeBusy(true);
            setProbeResult(null);
            try {
              const r = await fetch('/api/admin/testing/memory/probe', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: probeAction, ...payload }),
              });
              const data = (await r.json()) as ProbeResponse;
              setProbeResult(data);
            } catch (e) {
              setProbeResult({ ok: false, error: (e as Error).message });
            } finally {
              setProbeBusy(false);
            }
          }}
        />
        {probeResult ? (
          <pre style={{ marginTop: 12, padding: 12, background: 'var(--pc-color-surface-2, #111)', overflow: 'auto', maxHeight: 360 }}>
            {JSON.stringify(probeResult, null, 2)}
          </pre>
        ) : null}
      </section>
    </>
  );
}

function HealthStrip({ health }: { health: HealthPayload | null }) {
  if (!health) return <div className="pc-test-tab-hint">Loading health…</div>;
  const pill = (label: string, ok: boolean | string, hint?: string) => (
    <span
      key={label}
      title={hint}
      style={{
        display: 'inline-flex',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 6,
        background: typeof ok === 'string' ? 'var(--pc-color-surface-2, #222)' : ok ? 'var(--good-bg, #173)' : 'var(--bad-bg, #722)',
        color: typeof ok === 'string' ? 'var(--pc-color-text, #ddd)' : ok ? 'var(--good, #bfb)' : 'var(--bad, #fbb)',
        fontSize: 12,
      }}
    >
      <strong>{label}</strong>
      <span>{typeof ok === 'string' ? ok : ok ? '✓' : '✗'}</span>
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0' }}>
      {pill('pgvector', health.pgvector)}
      {pill('mem0', health.mem0_ready, health.embedder_mode ?? 'unknown')}
      {pill('embedder', health.embedder_mode ?? 'disabled')}
      {pill('anthropic', health.has_anthropic_key)}
      {pill('openai', health.has_openai_key)}
      {health.entry_count_workspace_shared !== null
        ? pill('shared entries', String(health.entry_count_workspace_shared))
        : null}
      {pill('feedback 24h', String(health.recent_feedback_24h))}
      {health.blocking_reason ? (
        <span style={{ color: 'var(--bad, #fbb)', fontSize: 12 }}>{health.blocking_reason}</span>
      ) : null}
    </div>
  );
}

function CheckList({ catalog, results, progressId, selectedId, onSelect }: {
  catalog: Array<{ id: string; label: string }>;
  results: AdminTestCheckResult[];
  progressId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(results.map((r) => [r.id, r] as const)), [results]);
  const rows = catalog.length > 0
    ? catalog
    : results.map((r) => ({ id: r.id, label: r.label }));
  return (
    <div className="pc-test-section" role="list" aria-label="Memory suite checks">
      {rows.length === 0 ? <div className="pc-test-tab-hint">Catalog loading…</div> : null}
      {rows.map((c) => {
        const r = byId.get(c.id);
        const status = r?.status ?? (progressId === c.id ? 'running' : 'pending');
        const isSelected = selectedId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className="pc-test-tab"
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              border: isSelected ? '1px solid var(--pc-color-primary, #58f)' : '1px solid transparent',
              padding: '6px 10px',
              marginBottom: 4,
              background: isSelected ? 'var(--pc-color-surface-2, #1a1a22)' : 'transparent',
            }}
          >
            <span className="pc-test-tab-label">{c.label}</span>
            <StatusBadge status={status} />
          </button>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: AdminTestCheckResult['status'] | 'pending' | 'running' }) {
  const map: Record<string, { label: string; color: string }> = {
    pass: { label: '✓', color: 'var(--good, #4d9)' },
    warn: { label: '!', color: 'var(--warn, #fc6)' },
    fail: { label: '✗', color: 'var(--bad, #f66)' },
    skip: { label: '–', color: 'var(--pc-color-muted, #888)' },
    pending: { label: '·', color: 'var(--pc-color-muted, #555)' },
    running: { label: '…', color: 'var(--pc-color-primary, #58f)' },
  };
  const m = map[status] ?? map.pending;
  return <span style={{ color: m.color, fontFamily: 'monospace', fontSize: 14 }}>{m.label}</span>;
}

function CheckDetail({ checkId, result }: { checkId: string | null; result: AdminTestCheckResult | null }) {
  if (!checkId) {
    return <div className="pc-test-tab-hint" style={{ padding: 8 }}>Select a check on the left.</div>;
  }
  if (!result) {
    return <div className="pc-test-tab-hint" style={{ padding: 8 }}>Check <code>{checkId}</code> hasn't run yet in this session.</div>;
  }
  return (
    <div className="pc-test-section" style={{ padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>{result.label}</h3>
      <div style={{ fontSize: 12, marginBottom: 4 }}>
        <strong>Status:</strong> <StatusBadge status={result.status} /> {result.status} · {result.durationMs}ms
      </div>
      <div style={{ marginBottom: 8 }}>
        <div><strong>Expected:</strong> {result.expected}</div>
        <div><strong>Actual:</strong> {result.actual}</div>
      </div>
      {result.details && result.details.length > 0 ? (
        <pre style={{ background: 'var(--pc-color-surface-2, #111)', padding: 8, overflow: 'auto', maxHeight: 240 }}>
          {result.details.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

interface ProbePayload {
  content?: string;
  query?: string;
  id?: string;
  kind?: string;
  shared?: boolean;
  expires_at?: string;
  limit?: number;
  include_shared?: boolean;
}

function ProbePanel({ action, busy, onSubmit }: { action: ProbeAction; busy: boolean; onSubmit: (p: ProbePayload) => Promise<void> }) {
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [id, setId] = useState('');
  const [kind, setKind] = useState<'identity' | 'preference' | 'project' | 'correction' | 'ephemeral'>('project');
  const [shared, setShared] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (action === 'remember') void onSubmit({ content, kind, shared });
    else if (action === 'search') void onSubmit({ query, limit: 6 });
    else if (action === 'list') void onSubmit({ kind: kind, include_shared: true });
    else if (action === 'forget') void onSubmit({ id });
    else if (action === 'update') void onSubmit({ id, content });
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {action === 'remember' || action === 'update' ? (
        <textarea
          required
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="memory content (e.g. 'I prefer dark mode')"
          rows={3}
          style={{ fontFamily: 'inherit' }}
        />
      ) : null}
      {action === 'search' ? (
        <input
          required
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search query (e.g. 'preferences')"
        />
      ) : null}
      {action === 'forget' || action === 'update' ? (
        <input
          required
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="memory id (UUID, get from list/search)"
        />
      ) : null}
      {action === 'remember' || action === 'list' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>kind:
            <Select
              value={kind}
              onChange={(value) => setKind(value as typeof kind)}
              ariaLabel="Memory kind"
              options={[
                { value: 'identity', label: 'identity' },
                { value: 'preference', label: 'preference' },
                { value: 'project', label: 'project' },
                { value: 'correction', label: 'correction' },
                { value: 'ephemeral', label: 'ephemeral' },
              ]}
            />
          </label>
          {action === 'remember' ? (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Checkbox checked={shared} onChange={setShared} ariaLabel="Workspace-shared memory" />
              workspace-shared
            </label>
          ) : null}
        </div>
      ) : null}
      <div>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Working…' : action}</Button>
      </div>
    </form>
  );
}
