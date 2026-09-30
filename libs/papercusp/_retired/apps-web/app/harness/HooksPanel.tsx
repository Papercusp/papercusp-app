'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';

const KNOWN_HOOKS = ['pre-worker', 'post-worker', 'pre-validator', 'post-validator', 'on-escalate', 'on-feature-passed', 'on-feature-failing'] as const;
type HookName = (typeof KNOWN_HOOKS)[number];

const PLACEHOLDERS: Record<HookName, string> = {
  'pre-worker': `#!/usr/bin/env bash
# pre-worker — runs before each worker invocation.
# Env: ROLE=worker, FEATURE_ID, PROJECT_DIR, STATE_DIR
# Non-zero exits are warned but don't halt the mission.

echo "worker starting: $FEATURE_ID"
`,
  'post-worker': `#!/usr/bin/env bash
# post-worker — runs after each worker invocation.
# Env: ROLE=worker, FEATURE_ID, RC (worker exit code), PROJECT_DIR, STATE_DIR

echo "worker $FEATURE_ID done rc=$RC"
# Example: auto-commit on success
# [ "$RC" = "0" ] && cd "$PROJECT_DIR" && git add -A && git commit -m "worker: $FEATURE_ID" || true
`,
  'pre-validator': `#!/usr/bin/env bash
# pre-validator — runs before each validator invocation.
# Env: ROLE=validator, FEATURE_ID, PROJECT_DIR, STATE_DIR

echo "validator starting: $FEATURE_ID"
`,
  'post-validator': `#!/usr/bin/env bash
# post-validator — runs after each validator invocation.
# Env: ROLE=validator, FEATURE_ID, RC, PROJECT_DIR, STATE_DIR

echo "validator $FEATURE_ID done rc=$RC"
`,
  'on-escalate': `#!/usr/bin/env bash
# on-escalate — runs when the orchestrator decides to escalate.
# Env: REASON, PROJECT_DIR, STATE_DIR

echo "escalation: $REASON"
# Example: desktop/push notification
# notify-send "Harness escalated" "$REASON" || true
`,
  'on-feature-passed': `#!/usr/bin/env bash
# on-feature-passed — runs when validator transitions a feature to passed.
# Env: FEATURE_ID, STATUS=passed, PROJECT_DIR, STATE_DIR

echo "feature passed: $FEATURE_ID"
# Example: notify team, trigger downstream job, etc.
`,
  'on-feature-failing': `#!/usr/bin/env bash
# on-feature-failing — runs when validator transitions a feature to failing.
# Env: FEATURE_ID, STATUS=failing, PROJECT_DIR, STATE_DIR

echo "feature failing: $FEATURE_ID"
# Example: push-notify, log to bug tracker
`,
};

interface HookEntry {
  name: HookName;
  exists: boolean;
  executable: boolean;
  content: string | null;
}

interface HookRun {
  logId: string;
  name: string;
  ts: number;
  sizeBytes: number;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const HOOK_COLOR: Record<string, string> = {
  'pre-worker': '#3b82f6',
  'post-worker': '#10b981',
  'pre-validator': '#a855f7',
  'post-validator': '#8b5cf6',
  'on-escalate': '#f59e0b',
  'on-feature-passed': '#22c55e',
  'on-feature-failing': '#ef4444',
};

interface Props {
  slug: string;
  alive: boolean;
  onClose: () => void;
}

export default function HooksPanel({ slug, alive, onClose }: Props) {
  const [tab, setTab] = useState<HookName>('pre-worker');
  const [hooks, setHooks] = useState<Record<HookName, HookEntry> | null>(null);
  const [draft, setDraft] = useState<Record<HookName, string>>(() => Object.fromEntries(KNOWN_HOOKS.map((n) => [n, ''])) as Record<HookName, string>);
  const [saving, setSaving] = useState<HookName | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [runs, setRuns] = useState<HookRun[]>([]);
  const [selectedLog, setSelectedLog] = useState<{ logId: string; content: string } | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);

  const load = useCallback(async () => {
    const d = await fetch(`/api/harness/${slug}/hooks`).then((r) => r.json());
    const map = Object.fromEntries(d.hooks.map((h: HookEntry) => [h.name, h])) as Record<HookName, HookEntry>;
    setHooks(map);
    setDraft((prev) => {
      const next = { ...prev };
      for (const name of KNOWN_HOOKS) {
        next[name] = map[name]?.content ?? '';
      }
      return next;
    });
  }, [slug]);

  useEffect(() => { load().catch((e) => setToast(`load: ${e}`)); }, [load]);

  const loadRuns = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/hook-logs`).then((r) => r.json());
      setRuns(d.runs ?? []);
    } catch {}
  }, [slug]);

  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 3000);
    return () => clearInterval(t);
  }, [loadRuns]);

  const openLog = useCallback(async (logId: string) => {
    setLoadingLog(true);
    try {
      const d = await fetch(`/api/harness/${slug}/hook-logs/${logId}`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setSelectedLog(d);
    } catch (e) {
      setToast(`log: ${e}`);
      setTimeout(() => setToast(null), 2500);
    } finally {
      setLoadingLog(false);
    }
  }, [slug]);

  const dirty = useMemo(() => {
    if (!hooks) return new Set<HookName>();
    const d = new Set<HookName>();
    for (const name of KNOWN_HOOKS) {
      const orig = hooks[name]?.content ?? '';
      if ((draft[name] ?? '') !== orig) d.add(name);
    }
    return d;
  }, [hooks, draft]);

  const save = useCallback(async (name: HookName) => {
    setSaving(name);
    try {
      const content = draft[name];
      if (!content || content.trim() === '') {
        throw new Error('cannot save empty hook — use "remove" to delete');
      }
      const r = await fetch(`/api/harness/${slug}/hooks/${name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast(`saved: ${name}`);
      await load();
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setSaving(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, draft, load]);

  const remove = useCallback(async (name: HookName) => {
    if (!confirm(`Delete ${name}.sh? The hook will no longer fire.`)) return;
    setSaving(name);
    try {
      const r = await fetch(`/api/harness/${slug}/hooks/${name}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast(`removed: ${name}`);
      setDraft((d) => ({ ...d, [name]: '' }));
      await load();
    } catch (e) {
      setToast(`delete failed: ${e}`);
    } finally {
      setSaving(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, load]);

  const insertPlaceholder = useCallback((name: HookName) => {
    setDraft((d) => ({ ...d, [name]: PLACEHOLDERS[name] }));
  }, []);

  // Cmd+S save active tab
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty.has(tab)) save(tab);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dirty, tab, save]);

  const activeEntry = hooks?.[tab];
  const isActiveDirty = dirty.has(tab);
  const isEmpty = (draft[tab] ?? '').trim() === '';

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '88vw', height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: '#e5e7eb' }}>Hooks — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>
            .papercusp/hooks/{tab}.sh
          </span>
          {alive && (
            <span style={{ color: '#f59e0b', fontSize: '0.8rem', marginLeft: '1rem' }}>
              ⚠ harness running — changes apply from next invocation
            </span>
          )}
          <span style={{ color: '#6b7280', fontSize: '0.7rem', marginLeft: alive ? 0 : '1rem' }}>
            Built-ins (branch_iso, auto_screenshot) also fire automatically — see config.json.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {toast && (
              <span style={{ color: /failed/i.test(toast) ? '#ef4444' : '#10b981', fontSize: '0.8rem' }}>{toast}</span>
            )}
            {activeEntry?.exists && (
              <button
                onClick={() => remove(tab)}
                disabled={!!saving}
                style={{ background: 'transparent', color: '#f87171', border: '1px solid #7f1d1d', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
                title="Delete this hook file (it will no longer fire)"
              >
                remove
              </button>
            )}
            <button
              onClick={() => save(tab)}
              disabled={!isActiveDirty || isEmpty || !!saving}
              style={{ background: isActiveDirty && !isEmpty ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: isActiveDirty && !isEmpty ? 'pointer' : 'not-allowed', fontWeight: 600 }}
              title="Save hook (⌘/Ctrl+S). chmod 755 applied on server."
            >
              {saving === tab ? 'saving…' : 'save'}
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
            >
              close
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '0.25rem', padding: '0.35rem 1rem', borderBottom: '1px solid #1f2937', background: '#0f141f' }}>
          {KNOWN_HOOKS.map((name) => {
            const isActive = name === tab;
            const isDirty = dirty.has(name);
            const entry = hooks?.[name];
            return (
              <button
                key={name}
                onClick={() => setTab(name)}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? '#e5e7eb' : '#9ca3af',
                  border: '1px solid ' + (isActive ? '#374151' : 'transparent'),
                  borderRadius: 3,
                  padding: '0.3rem 0.75rem',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {entry?.exists ? '●' : '○'}
                {name}
                {isDirty && <span style={{ color: '#f59e0b' }}>●</span>}
              </button>
            );
          })}
        </div>

        {/* Editor */}
        <div style={{ flex: '1 1 60%', position: 'relative', minHeight: 0 }}>
          {!hooks ? (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>loading…</div>
          ) : (
            <>
              <Editor
                height="100%"
                language="shell"
                theme="vs-dark"
                value={draft[tab] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [tab]: v ?? '' }))}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
              {isEmpty && (
                <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: '#111827', border: '1px solid #374151', padding: '0.5rem 0.75rem', borderRadius: 3, fontSize: '0.8rem', color: '#9ca3af', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  hook not yet created
                  <button
                    onClick={() => insertPlaceholder(tab)}
                    style={{ background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 3, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.75rem' }}
                  >
                    insert template
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Recent runs + detail */}
        <div style={{ flex: '0 0 40%', borderTop: '1px solid #1f2937', display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 38%', borderRight: '1px solid #1f2937', overflow: 'auto', padding: '0.5rem 0.75rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              recent hook runs
              <span style={{ color: '#6b7280' }}>({runs.length})</span>
              {runs.length === 0 && <span style={{ color: '#6b7280', fontStyle: 'italic' }}>none yet — fire a hook to see logs here</span>}
            </div>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <tbody>
                {runs.map((r) => {
                  const isSelected = selectedLog?.logId === r.logId;
                  return (
                    <tr
                      key={r.logId}
                      onClick={() => openLog(r.logId)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? '#1f2937' : 'transparent',
                      }}
                    >
                      <td style={{ padding: '0.25rem 0.4rem', color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtTs(r.ts)}</td>
                      <td style={{ padding: '0.25rem 0.4rem' }}>
                        <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: HOOK_COLOR[r.name] ?? '#374151', color: 'white', fontWeight: 600 }}>
                          {r.name}
                        </span>
                      </td>
                      <td style={{ padding: '0.25rem 0.4rem', textAlign: 'right', color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {r.sizeBytes}B
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', padding: '0.5rem 0.75rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              log output
              {selectedLog && <code style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>{selectedLog.logId}.log</code>}
              {loadingLog && <span style={{ color: '#6b7280' }}>loading…</span>}
            </div>
            <pre style={{ flex: 1, overflow: 'auto', margin: 0, padding: '0.5rem 0.75rem', fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace', color: '#d1d5db', whiteSpace: 'pre-wrap' }}>
              {selectedLog ? (selectedLog.content || '(empty)') : '(click a row to view)'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
