'use client';

import './harness.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { Inbox, Send, FileText, NotebookPen, Workflow, Cpu, Brain } from 'lucide-react';

type Department = {
  slug: string;
  harnessSlug: string;
  name: string;
  mandate: string;
  inboxKinds: string[];
  outboxKinds: string[];
};

type OrgMessage = {
  id: string;
  ts: number;
  from: string;
  to: string[];
  kind: string;
  subject: string;
  body: string;
  refId?: string;
  projectId?: string;
  directiveId?: string;
  status: 'pending' | 'acknowledged' | 'actioned' | 'archived';
  metadata?: Record<string, unknown>;
};

type ProjectLite = { id: string; slug: string; name: string; vertical: string; status: string };

type Tab = 'inbox' | 'outbox' | 'compose' | 'charter' | 'notes' | 'decisions' | 'memory' | 'director';

interface Props {
  harnessSlug: string;       // e.g. "org-business"
  departmentSlug: string;    // e.g. "business"
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusColor(s: OrgMessage['status']): string {
  if (s === 'pending') return 'var(--warn)';
  if (s === 'acknowledged') return 'var(--accent)';
  if (s === 'actioned') return 'var(--good)';
  return 'var(--fg-dim)';
}

export default function DepartmentHarnessDashboard({ harnessSlug, departmentSlug }: Props) {
  const [tab, setTab] = useState<Tab>('inbox');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [self, setSelf] = useState<Department | null>(null);
  const [inbox, setInbox] = useState<OrgMessage[]>([]);
  const [outbox, setOutbox] = useState<OrgMessage[]>([]);
  const [charter, setCharter] = useState<string>('');
  const [directorNotes, setDirectorNotes] = useState<string>('');
  const [decisionLog, setDecisionLog] = useState<string>('');
  const [selectedMsg, setSelectedMsg] = useState<OrgMessage | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [deptsRes, inboxRes, outboxRes, dirNotesRes, decisionLogRes, charterRes, projectsRes] = await Promise.all([
        fetch('/api/org/departments').then((r) => r.json()),
        fetch(`/api/org/${departmentSlug}/inbox`).then((r) => r.json()),
        fetch(`/api/org/${departmentSlug}/outbox`).then((r) => r.json()),
        fetch(`/api/org/${departmentSlug}/notes`).then((r) => r.ok ? r.text() : '').catch(() => ''),
        fetch(`/api/org/${departmentSlug}/decisions`).then((r) => r.ok ? r.text() : '').catch(() => ''),
        fetch(`/api/org/charter`).then((r) => r.ok ? r.text() : ''),
        fetch('/api/org/projects').then((r) => r.json()).catch(() => ({ projects: [] })),
      ]);
      setDepartments(deptsRes.departments ?? []);
      setSelf((deptsRes.departments ?? []).find((d: Department) => d.slug === departmentSlug) ?? null);
      setInbox(inboxRes.messages ?? []);
      setOutbox(outboxRes.messages ?? []);
      setDirectorNotes(dirNotesRes);
      setDecisionLog(decisionLogRes);
      setCharter(charterRes);
      setProjects(projectsRes.projects ?? []);
    } catch (e) {
      toast.error(`refresh failed: ${e}`);
    }
  }, [departmentSlug, harnessSlug]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const pendingCount = inbox.filter((m) => m.status === 'pending').length;

  return (
    <div className="h-root" style={{ padding: 16 }}>
      <Toaster position="bottom-right" />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            {self?.name ?? departmentSlug} — Department Harness
          </h1>
          {self && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-dim)' }}>
              {self.mandate}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--fg-dim)' }}>
          <span>harness: <code>{harnessSlug}</code></span>
          <span>·</span>
          <span>{inbox.length} inbox · {outbox.length} outbox</span>
          {pendingCount > 0 && (
            <span style={{ color: 'var(--warn)' }}>· {pendingCount} pending</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
        {([
          { key: 'inbox',     label: 'Inbox',       icon: Inbox },
          { key: 'outbox',    label: 'Outbox',      icon: Send },
          { key: 'compose',   label: 'Compose',     icon: NotebookPen },
          { key: 'decisions', label: 'Decisions',   icon: Workflow },
          { key: 'charter',   label: 'Charter',     icon: FileText },
          { key: 'notes',     label: 'Director notes', icon: NotebookPen },
          { key: 'memory',    label: 'Memory',      icon: Brain },
          { key: 'director',  label: 'Director agent', icon: Cpu },
        ] as { key: Tab; label: string; icon: typeof Inbox }[]).map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                background: active ? 'var(--bg-2)' : 'transparent',
                border: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                color: active ? 'var(--fg)' : 'var(--fg-dim)',
                fontSize: 13,
                fontWeight: active ? 500 : 400,
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              <Icon size={14} />
              {t.label}
              {t.key === 'inbox' && pendingCount > 0 && (
                <span style={{ fontSize: 10, color: 'var(--warn)', background: 'var(--bg-3)', padding: '1px 6px', borderRadius: 10 }}>
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ display: 'grid', gridTemplateColumns: selectedMsg ? '1fr 400px' : '1fr', gap: 12 }}>
        <div>
          {tab === 'inbox' && (
            <MessageList
              messages={inbox}
              emptyText="No messages in inbox yet."
              onSelect={setSelectedMsg}
              selectedId={selectedMsg?.id}
              showFrom
            />
          )}
          {tab === 'outbox' && (
            <MessageList
              messages={outbox}
              emptyText="No messages sent yet."
              onSelect={setSelectedMsg}
              selectedId={selectedMsg?.id}
              showTo
            />
          )}
          {tab === 'compose' && self && (
            <ComposeMessage self={self} departments={departments} projects={projects} onSent={() => { refresh(); setTab('outbox'); }} />
          )}
          {tab === 'decisions' && (
            <MarkdownPanel title="Decision log" content={decisionLog} empty="No decisions recorded yet." />
          )}
          {tab === 'charter' && (
            <MarkdownPanel title="Org Charter" content={charter} empty="Charter not loaded." />
          )}
          {tab === 'notes' && (
            <NotesEditor
              departmentSlug={departmentSlug}
              initialContent={directorNotes}
              onSaved={refresh}
            />
          )}
          {tab === 'memory' && (
            <MemoryPanel departmentSlug={departmentSlug} />
          )}
          {tab === 'director' && self && (
            <DirectorAgentPanel departmentSlug={departmentSlug} self={self} />
          )}
        </div>

        {selectedMsg && (
          <MessageDetail
            message={selectedMsg}
            onClose={() => setSelectedMsg(null)}
            onStatusChange={async (newStatus) => {
              await fetch(`/api/org/messages/${selectedMsg.id}/status`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
              });
              refresh();
              setSelectedMsg({ ...selectedMsg, status: newStatus });
            }}
          />
        )}
      </div>
    </div>
  );
}

function MessageList({
  messages,
  emptyText,
  onSelect,
  selectedId,
  showFrom,
  showTo,
}: {
  messages: OrgMessage[];
  emptyText: string;
  onSelect: (m: OrgMessage) => void;
  selectedId?: string;
  showFrom?: boolean;
  showTo?: boolean;
}) {
  if (messages.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-dim)', fontSize: 13, background: 'var(--bg-2)', border: '1px dashed var(--border)', borderRadius: 8 }}>
        {emptyText}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {messages.map((m) => {
        const selected = m.id === selectedId;
        return (
          <button
            key={m.id}
            onClick={() => onSelect(m)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '10px 12px',
              background: selected ? 'var(--bg-3)' : 'var(--bg-2)',
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6,
              textAlign: 'left',
              cursor: 'pointer',
              color: 'var(--fg)',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              <span
                style={{
                  padding: '1px 6px',
                  background: 'var(--bg-3)',
                  color: 'var(--accent)',
                  borderRadius: 4,
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {m.kind}
              </span>
              {showFrom && <span style={{ color: 'var(--fg-dim)' }}>from <b style={{ color: 'var(--fg)' }}>{m.from}</b></span>}
              {showTo && <span style={{ color: 'var(--fg-dim)' }}>to <b style={{ color: 'var(--fg)' }}>{m.to.join(', ')}</b></span>}
              <span style={{ color: statusColor(m.status), marginLeft: 'auto' }}>{m.status}</span>
              <span style={{ color: 'var(--fg-dim)', fontSize: 10 }}>{relativeTime(m.ts)}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{m.subject}</div>
          </button>
        );
      })}
    </div>
  );
}

function MessageDetail({
  message,
  onClose,
  onStatusChange,
}: {
  message: OrgMessage;
  onClose: () => void;
  onStatusChange: (s: OrgMessage['status']) => void;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
        position: 'sticky',
        top: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span
          style={{
            padding: '2px 8px',
            background: 'var(--bg-3)',
            color: 'var(--accent)',
            borderRadius: 4,
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
          }}
        >
          {message.kind}
        </span>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: 'var(--fg-dim)', fontSize: 18, cursor: 'pointer', padding: 0 }}
        >
          ×
        </button>
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{message.subject}</h3>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div>from: <b style={{ color: 'var(--fg)' }}>{message.from}</b></div>
        <div>to: <b style={{ color: 'var(--fg)' }}>{message.to.join(', ')}</b></div>
        <div>ts: {new Date(message.ts).toISOString()}</div>
        {message.refId && <div>refId: <code>{message.refId}</code></div>}
        {message.projectId && <div>projectId: <code>{message.projectId}</code></div>}
      </div>

      <pre
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: 10,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--fg)',
          fontFamily: 'inherit',
        }}
      >
        {message.body}
      </pre>

      <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['pending', 'acknowledged', 'actioned', 'archived'] as const).map((s) => (
          <button
            key={s}
            onClick={() => onStatusChange(s)}
            disabled={message.status === s}
            style={{
              fontSize: 11,
              padding: '4px 10px',
              background: message.status === s ? statusColor(s) : 'var(--bg-3)',
              color: message.status === s ? 'var(--bg)' : statusColor(s),
              border: `1px solid ${statusColor(s)}`,
              borderRadius: 4,
              cursor: message.status === s ? 'default' : 'pointer',
              opacity: message.status === s ? 1 : 0.8,
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ComposeMessage({
  self,
  departments,
  projects,
  onSent,
}: {
  self: Department;
  departments: Department[];
  projects: ProjectLite[];
  onSent: () => void;
}) {
  const [kind, setKind] = useState<string>(self.outboxKinds[0] ?? '');
  const [to, setTo] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [projectSlug, setProjectSlug] = useState<string>('');
  const [sending, setSending] = useState(false);

  const allDeptSlugs = useMemo(() => departments.map((d) => d.slug), [departments]);

  // Default project: org-ops for governance kinds, platform for shared kinds, else first non-reserved
  useMemo(() => {
    if (projectSlug) return;
    if (kind === 'PlatformUpdate' || kind === 'Capability') {
      setProjectSlug('platform');
    } else {
      setProjectSlug('org-ops');
    }
  }, [kind, projects, projectSlug]);

  async function send() {
    if (!kind || !to.length || !subject.trim() || !body.trim() || !projectSlug) {
      toast.error('kind, to, project, subject, and body are all required');
      return;
    }
    setSending(true);
    try {
      const res = await fetch('/api/org/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: self.slug, to, kind, subject, body, projectId: projectSlug }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'send failed');
      }
      toast.success(`sent ${kind} to ${to.join(', ')}`);
      setSubject('');
      setBody('');
      setTo([]);
      onSent();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Kind</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            style={{
              width: '100%', padding: '8px', background: 'var(--bg)',
              color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
            }}
          >
            {self.outboxKinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Project *</label>
          <select
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value)}
            style={{
              width: '100%', padding: '8px', background: 'var(--bg)',
              color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
            }}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name} {p.slug.includes('reserved') ? '' : `(${p.vertical})`}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>To</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allDeptSlugs.filter((s) => s !== self.slug).map((s) => {
              const active = to.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTo(active ? to.filter((x) => x !== s) : [...to, s])}
                  style={{
                    padding: '6px 12px',
                    background: active ? 'var(--accent)' : 'var(--bg-3)',
                    color: active ? 'var(--bg)' : 'var(--fg)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px', background: 'var(--bg)',
            color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
          }}
          placeholder="Short one-line subject"
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Body (markdown)</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px', background: 'var(--bg)',
            color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
            fontFamily: 'ui-monospace, monospace', lineHeight: 1.5,
          }}
          placeholder="The full message body. Supports markdown."
        />
      </div>
      <button
        onClick={send}
        disabled={sending}
        style={{
          padding: '10px 20px',
          background: 'var(--accent)',
          color: 'var(--bg)',
          border: 'none',
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 500,
          cursor: sending ? 'default' : 'pointer',
          opacity: sending ? 0.6 : 1,
        }}
      >
        {sending ? 'Sending…' : `Send ${kind || 'message'}`}
      </button>
    </div>
  );
}

function DirectorAgentPanel({ departmentSlug, self }: { departmentSlug: string; self: Department }) {
  const [role, setRole] = useState<'orchestrator' | 'worker' | 'validator' | 'documenter' | 'summarizer'>('orchestrator');
  const [mode, setMode] = useState<string>('');
  const [resolved, setResolved] = useState<string>('');
  const [sections, setSections] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [looping, setLooping] = useState(false);
  const [autoLoop, setAutoLoop] = useState(false);
  const [autoIntervalSeconds, setAutoIntervalSeconds] = useState(60);
  const [runResult, setRunResult] = useState<{ decisionLine?: string; decisionKeyword?: string | null; stdout?: string; runPath?: string; timedOut?: boolean; exitCode?: number | null } | null>(null);
  const [loopResult, setLoopResult] = useState<{ final: string; trace: any[]; runPath: string } | null>(null);
  const [recentRuns, setRecentRuns] = useState<{ filename: string; ts: string | null; decisionKeyword: string | null }[]>([]);

  const isCeoEligible = departmentSlug === 'business' && role === 'worker';

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ role });
      if (mode) params.set('mode', mode);
      const res = await fetch(`/api/org/${departmentSlug}/prompt?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'load failed');
      }
      const data = await res.json();
      setResolved(data.resolved ?? '');
      setSections(data.sections ?? []);
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function runDirector() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch(`/api/org/${departmentSlug}/run-director`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, mode: mode || undefined, timeoutMs: 90000 }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'run failed');
      }
      const data = await res.json();
      setRunResult(data);
      toast.success(`Director ran. Decision: ${data.decisionKeyword ?? '(no keyword)'}`);
      loadRecentRuns();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setRunning(false);
    }
  }

  async function runLoop() {
    setLooping(true);
    setLoopResult(null);
    try {
      const res = await fetch(`/api/org/${departmentSlug}/run-loop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxIterations: 3, timeoutMsPerStep: 120000 }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'loop failed');
      }
      const data = await res.json();
      setLoopResult(data);
      toast.success(`Loop finished: ${data.final} (${data.trace.length} steps)`);
      loadRecentRuns();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLooping(false);
    }
  }

  async function loadRecentRuns() {
    try {
      const res = await fetch(`/api/org/${departmentSlug}/director-runs`);
      const data = await res.json();
      setRecentRuns(data.runs ?? []);
    } catch {}
  }

  useEffect(() => {
    loadRecentRuns();
    // Load persisted director config
    fetch(`/api/org/${departmentSlug}/director-config`)
      .then((r) => r.json())
      .then((cfg) => {
        if (typeof cfg.autoLoop === 'boolean') setAutoLoop(cfg.autoLoop);
        if (typeof cfg.autoIntervalSeconds === 'number') setAutoIntervalSeconds(cfg.autoIntervalSeconds);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentSlug]);

  // Persist autoLoop / interval changes to disk
  useEffect(() => {
    fetch(`/api/org/${departmentSlug}/director-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoLoop, autoIntervalSeconds }),
    }).catch(() => {});
  }, [autoLoop, autoIntervalSeconds, departmentSlug]);

  // Auto-loop polling: every N seconds, run the loop if not currently running.
  useEffect(() => {
    if (!autoLoop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (!looping && !running) {
        await runLoop();
      }
      if (!cancelled) {
        timer = setTimeout(tick, autoIntervalSeconds * 1000);
      }
    };
    timer = setTimeout(tick, autoIntervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoop, autoIntervalSeconds, departmentSlug]);

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(resolved);
      toast.success('prompt copied to clipboard');
    } catch (e) {
      toast.error(`copy failed: ${e}`);
    }
  }

  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Director agent — prompt resolver
      </div>

      <p style={{ fontSize: 12, color: 'var(--fg-dim)', lineHeight: 1.6, margin: '0 0 16px' }}>
        The director agent's prompt is composed by inheritance: <code>base/{role}.md</code> + <code>department/{role}.md</code>
        {' '}+ <code>department/departments/{departmentSlug}/{role}.md</code> (if exists).
        Click <strong>Run director</strong> to spawn <code>claude</code> with the resolved prompt + live state (charter, inbox, outbox, notes) and capture its decision.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as any)}
            style={{ padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 }}
          >
            <option value="orchestrator">orchestrator</option>
            <option value="worker">worker</option>
            <option value="validator">validator</option>
            <option value="documenter">documenter</option>
            <option value="summarizer">summarizer</option>
          </select>
        </div>
        {isCeoEligible && (
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              style={{ padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13 }}
            >
              <option value="">default</option>
              <option value="ceo">ceo</option>
            </select>
          </div>
        )}
        <button
          onClick={runLoop}
          disabled={looping || running}
          title="Orchestrator → worker → execute actions, looping until DONE/ESCALATE"
          style={{ padding: '8px 16px', background: 'var(--counter)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: looping ? 0.6 : 1 }}
        >
          {looping ? 'Looping…' : '⟳ Run autonomous loop'}
        </button>
        {(looping || running) && (
          <button
            onClick={async () => {
              try {
                const res = await fetch(`/api/org/${departmentSlug}/stop-loop`, { method: 'POST' });
                if (res.ok) toast.success('stop signal sent');
                else { const e = await res.json(); toast.error(e.error ?? 'no active run to stop'); }
              } catch (e) { toast.error(`${e}`); }
            }}
            style={{ padding: '8px 16px', background: 'var(--bad)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            ■ Stop
          </button>
        )}
        <button
          onClick={runDirector}
          disabled={running || looping}
          title="One-shot: just the orchestrator's decision, no execution"
          style={{ padding: '8px 16px', background: 'var(--good)', color: 'var(--bg)', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: running ? 0.6 : 1 }}
        >
          {running ? 'Running…' : '▶ Run orchestrator only'}
        </button>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: '8px 16px', background: 'var(--bg-3)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Resolving…' : 'Show prompt only'}
        </button>
        {resolved && (
          <button
            onClick={copyToClipboard}
            style={{ padding: '8px 16px', background: 'var(--bg-3)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}
          >
            Copy prompt
          </button>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg-dim)', marginLeft: 'auto' }}>
          <input
            type="checkbox"
            checked={autoLoop}
            onChange={(e) => setAutoLoop(e.target.checked)}
            style={{ accentColor: 'var(--counter)' }}
          />
          <span>auto-loop every</span>
          <input
            type="number"
            value={autoIntervalSeconds}
            min={30}
            max={3600}
            onChange={(e) => setAutoIntervalSeconds(Math.max(30, parseInt(e.target.value, 10) || 60))}
            style={{ width: 60, padding: 4, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 12 }}
          />
          <span>sec</span>
          {autoLoop && <span style={{ color: 'var(--counter)', fontWeight: 500 }}>● ON</span>}
        </label>
      </div>

      {loopResult && (
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg)', border: `1px solid ${loopResult.final === 'done' ? 'var(--good)' : 'var(--warn)'}`, borderLeft: `3px solid ${loopResult.final === 'done' ? 'var(--good)' : 'var(--warn)'}`, borderRadius: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Autonomous loop · final: <b style={{ color: loopResult.final === 'done' ? 'var(--good)' : 'var(--warn)' }}>{loopResult.final}</b> · {loopResult.trace.length} steps
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            {loopResult.trace.map((t: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 8px', background: 'var(--bg-3)', borderRadius: 3 }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--fg-dim)', minWidth: 50 }}>iter {t.iter}</span>
                <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--accent)', minWidth: 130 }}>{t.step}</span>
                <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                  {t.decisionLine && <code style={{ color: 'var(--good)' }}>{t.decisionLine}</code>}
                  {t.error && <span style={{ color: 'var(--bad)' }}>error: {t.error}</span>}
                  {t.count !== undefined && <span style={{ color: 'var(--fg-dim)' }}>{t.count} actions executed</span>}
                </span>
              </div>
            ))}
          </div>
          {loopResult.runPath && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace' }}>
              saved: {loopResult.runPath}
            </div>
          )}
        </div>
      )}

      {runResult && (
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--bg)', border: `1px solid ${runResult.decisionKeyword ? 'var(--good)' : 'var(--warn)'}`, borderLeft: `3px solid ${runResult.decisionKeyword ? 'var(--good)' : 'var(--warn)'}`, borderRadius: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Director run · decision: {runResult.decisionKeyword ?? '(no keyword)'}
            {runResult.timedOut ? ' · TIMED OUT' : ''}
          </div>
          {runResult.decisionLine && (
            <pre style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'ui-monospace, monospace', margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>
              {runResult.decisionLine}
            </pre>
          )}
          {runResult.stdout && (
            <details>
              <summary style={{ fontSize: 11, color: 'var(--fg-dim)', cursor: 'pointer' }}>full stdout</summary>
              <pre style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-3)', padding: 8, borderRadius: 3, maxHeight: 300, overflowY: 'auto' }}>
                {runResult.stdout}
              </pre>
            </details>
          )}
          {runResult.runPath && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace' }}>
              saved: {runResult.runPath}
            </div>
          )}
        </div>
      )}

      {recentRuns.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontSize: 11, color: 'var(--fg-dim)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Recent runs ({recentRuns.length})
          </summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentRuns.map((r) => (
              <RunRow key={r.filename} run={r} departmentSlug={departmentSlug} />
            ))}
          </div>
        </details>
      )}

      {sections.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 8 }}>
          Composed from: {sections.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}
          ({resolved.length.toLocaleString()} chars)
        </div>
      )}

      {resolved && (
        <pre
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 12,
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 600,
            overflowY: 'auto',
            margin: 0,
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--fg)',
          }}
        >
          {resolved}
        </pre>
      )}
    </div>
  );
}

function MemoryPanel({ departmentSlug }: { departmentSlug: string }) {
  const [memory, setMemory] = useState<{
    text: string;
    entries: Array<{ filename: string; ts: string | null; decision: string | null; firstAction: string | null; final: string | null }>;
  } | null>(null);
  const [limit, setLimit] = useState(12);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/org/${departmentSlug}/memory?limit=${limit}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setMemory({ text: j.text, entries: j.entries ?? [] });
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [departmentSlug, limit]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--fg)' }}>Director memory</h3>
        <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
          synthesized from the {limit} most recent run records · injected into every prompt
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <label style={{ fontSize: 11, color: 'var(--fg-dim)' }}>Limit</label>
          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            style={{ padding: '4px 8px', background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: 4, fontSize: 12 }}
          >
            <option value={6}>6</option>
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={50}>50</option>
          </select>
          <button onClick={load} disabled={loading} style={{ padding: '4px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)', borderRadius: 4, fontSize: 12, cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {err && <div style={{ padding: 8, color: 'var(--err)', background: 'var(--bg-2)', borderRadius: 4, fontSize: 12 }}>Error: {err}</div>}
      {!memory || memory.entries.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--fg-dim)', fontSize: 13, background: 'var(--bg-2)', borderRadius: 6 }}>
          {loading ? 'Loading…' : 'No prior runs to synthesize. Memory will populate as the director runs.'}
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', background: 'var(--bg-2)', borderRadius: 6, border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg-3)' }}>
                  <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--fg-dim)', fontWeight: 500 }}>When</th>
                  <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--fg-dim)', fontWeight: 500 }}>Decision</th>
                  <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--fg-dim)', fontWeight: 500 }}>First action</th>
                  <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--fg-dim)', fontWeight: 500 }}>Final</th>
                </tr>
              </thead>
              <tbody>
                {memory.entries.map((e) => (
                  <tr key={e.filename} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px', color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>{e.ts ?? '—'}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--fg)' }}>{e.decision ?? '—'}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--fg)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.firstAction ?? '—'}</td>
                    <td style={{ padding: '6px 10px', color: 'var(--fg-dim)' }}>{e.final ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
            <summary style={{ cursor: 'pointer' }}>Raw text injected into prompt</summary>
            <pre style={{ marginTop: 8, padding: 10, background: 'var(--bg-2)', borderRadius: 4, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--fg)' }}>{memory.text}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function NotesEditor({ departmentSlug, initialContent, onSaved }: { departmentSlug: string; initialContent: string; onSaved: () => void }) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setContent(initialContent);
  }, [initialContent, dirty]);
  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/org/${departmentSlug}/notes`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: content,
      });
      if (!res.ok) throw new Error('save failed');
      toast.success('director notes saved');
      setDirty(false);
      onSaved();
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Director notes (operator guidance)
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {dirty && <span style={{ fontSize: 11, color: 'var(--warn)' }}>unsaved</span>}
          <button
            onClick={save}
            disabled={saving || !dirty}
            style={{ padding: '6px 14px', background: dirty ? 'var(--good)' : 'var(--bg-3)', color: dirty ? 'var(--bg)' : 'var(--fg-dim)', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: dirty ? 'pointer' : 'default', opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => { setContent(e.target.value); setDirty(true); }}
        rows={20}
        style={{
          width: '100%', boxSizing: 'border-box', padding: 12, background: 'var(--bg)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, lineHeight: 1.6,
          fontFamily: 'ui-monospace, monospace', resize: 'vertical', minHeight: 400,
        }}
      />
    </div>
  );
}

function RunRow({ run, departmentSlug }: { run: { filename: string; ts: string | null; decisionKeyword: string | null }; departmentSlug: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  async function load() {
    if (content) return;
    try {
      const res = await fetch(`/api/org/${departmentSlug}/director-runs/${run.filename}`);
      if (res.ok) setContent(await res.text());
    } catch {}
  }
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3 }}>
      <button
        onClick={() => { if (!open) load(); setOpen(!open); }}
        style={{ width: '100%', display: 'flex', gap: 12, padding: '4px 8px', background: 'transparent', border: 'none', color: 'var(--fg)', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}
      >
        <span style={{ color: 'var(--fg-dim)' }}>{open ? '▼' : '▶'}</span>
        <span style={{ color: 'var(--accent)', fontFamily: 'ui-monospace, monospace' }}>{run.decisionKeyword ?? '—'}</span>
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace', flex: 1 }}>{run.filename}</span>
        <span style={{ color: 'var(--fg-dim)' }}>{run.ts ? new Date(run.ts).toLocaleString() : ''}</span>
      </button>
      {open && content && (
        <pre style={{ margin: 0, padding: 10, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-3)', borderTop: '1px solid var(--border)', maxHeight: 400, overflowY: 'auto', fontFamily: 'ui-monospace, monospace' }}>
          {content}
        </pre>
      )}
    </div>
  );
}

function MarkdownPanel({ title, content, empty }: { title: string; content: string; empty: string }) {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </div>
      {content ? (
        <pre
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 12,
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--fg)',
            fontFamily: 'inherit',
            margin: 0,
            maxHeight: 600,
            overflowY: 'auto',
          }}
        >
          {content}
        </pre>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--fg-dim)', fontStyle: 'italic' }}>{empty}</div>
      )}
    </div>
  );
}
