'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';

type Tier = 'green' | 'yellow' | 'red';

interface MemFile {
  path: string;
  purpose: string;
  writtenBy: string[];
  readBy: string[];
  tier: Tier;
  language: 'markdown' | 'json' | 'jsonl' | 'text';
  exists: boolean;
  size: number;
  mtimeMs: number;
  editable: boolean;
  locked: boolean;
  optional?: boolean;
}

interface Props {
  slug: string;
  alive: boolean;
  onClose?: () => void;
}

const TIER_META: Record<Tier, { label: string; color: string; bg: string; border: string }> = {
  green:  { label: 'safe',     color: '#a7f3d0', bg: 'rgba(16,185,129,0.12)', border: '#10b981' },
  yellow: { label: 'caution',  color: '#fcd34d', bg: 'rgba(245,158,11,0.12)', border: '#f59e0b' },
  red:    { label: 'locked',   color: '#fca5a5', bg: 'rgba(239,68,68,0.12)',  border: '#ef4444' },
};

function fmtSize(n: number): string {
  if (n === 0) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtAgo(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export default function MemoryBrowser({ slug, alive }: Props) {
  const [files, setFiles] = useState<MemFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/memory`).then((r) => r.json());
      setFiles(d.files ?? []);
      // Auto-select first existing file if nothing active
      if (!active && d.files?.length) {
        const first = d.files.find((f: MemFile) => f.exists) ?? d.files[0];
        setActive(first.path);
      }
    } catch (e) {
      setToast(`load list failed: ${e}`);
    }
  }, [slug, active]);

  useEffect(() => { loadList(); }, [loadList]);

  const activeFile = useMemo(() => files.find((f) => f.path === active) ?? null, [files, active]);

  // Load content for active file
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    fetch(`/api/harness/${slug}/memory-file?path=${encodeURIComponent(active)}`)
      .then((r) => r.json())
      .then((d) => {
        const content = d.content ?? '';
        setOriginal(content);
        setDraft(content);
      })
      .catch((e) => setToast(`load failed: ${e}`))
      .finally(() => setLoading(false));
  }, [slug, active]);

  const dirty = original !== null && draft !== original;

  const save = useCallback(async () => {
    if (!active || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/harness/${slug}/memory-file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: active, content: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status}`);
      }
      setOriginal(draft);
      setToast('saved');
      setTimeout(() => setToast(null), 2000);
      loadList();
    } catch (e: any) {
      setToast(`save failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }, [active, draft, dirty, slug, loadList]);

  // Ctrl/Cmd+S to save
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  const grouped = useMemo(() => {
    const g: Record<Tier, MemFile[]> = { green: [], yellow: [], red: [] };
    for (const f of files) g[f.tier].push(f);
    return g;
  }, [files]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: '#0b0e14' }}>
      {/* Left: file list */}
      <div style={{
        width: 320,
        borderRight: '1px solid #1f2937',
        overflowY: 'auto',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '8px 10px',
          borderBottom: '1px solid #1f2937',
          fontSize: 11,
          color: '#9ca3af',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600 }}>Memory map</span>
          <span style={{ color: '#4b5563' }}>· {files.length}</span>
          {alive && (
            <span style={{ marginLeft: 'auto', color: '#f59e0b', fontSize: 10 }}>
              ⚠ harness running
            </span>
          )}
        </div>
        {(['green', 'yellow', 'red'] as Tier[]).map((tier) => {
          const group = grouped[tier];
          if (group.length === 0) return null;
          const meta = TIER_META[tier];
          return (
            <div key={tier}>
              <div style={{
                padding: '8px 10px 4px',
                fontSize: 10,
                color: meta.color,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                fontWeight: 600,
                background: '#0f141f',
                borderBottom: '1px solid #1f2937',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', background: meta.border,
                }} />
                {tier === 'green' ? 'Safe — edit anytime' : tier === 'yellow' ? 'Caution — edits may race' : 'Locked while harness is running'}
                <span style={{ marginLeft: 'auto', color: '#4b5563' }}>{group.length}</span>
              </div>
              {group.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={f.path === active}
                  onClick={() => setActive(f.path)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* Right: editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Editor header */}
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #1f2937',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontFamily: 'ui-monospace, monospace', color: '#e5e7eb', fontSize: 13 }}>
            {active ?? '—'}
          </span>
          {activeFile && (
            <>
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 3,
                background: TIER_META[activeFile.tier].bg,
                color: TIER_META[activeFile.tier].color,
                border: `1px solid ${TIER_META[activeFile.tier].border}`,
                fontWeight: 600,
              }}>
                {TIER_META[activeFile.tier].label}
              </span>
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                {activeFile.purpose}
              </span>
              {activeFile.locked && (
                <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 600 }}>
                  🛑 locked — stop harness to edit
                </span>
              )}
              {!activeFile.locked && activeFile.tier === 'yellow' && alive && (
                <span style={{ color: '#f59e0b', fontSize: 11 }}>
                  ⚠ agent may be writing to this file
                </span>
              )}
            </>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {toast && (
              <span style={{
                fontSize: 11,
                color: toast.startsWith('saved') ? '#10b981' : '#ef4444',
              }}>{toast}</span>
            )}
            <button
              onClick={() => { if (active && original !== null) setDraft(original); }}
              disabled={!dirty}
              style={{
                background: 'transparent',
                color: '#9ca3af',
                border: '1px solid #374151',
                borderRadius: 3,
                padding: '3px 9px',
                fontSize: 11,
                cursor: dirty ? 'pointer' : 'not-allowed',
                opacity: dirty ? 1 : 0.5,
              }}
            >revert</button>
            <button
              onClick={save}
              disabled={!dirty || saving || (activeFile?.locked ?? false)}
              style={{
                background: (dirty && !activeFile?.locked) ? '#2563eb' : '#374151',
                color: 'white',
                border: 'none',
                borderRadius: 3,
                padding: '3px 12px',
                fontSize: 11,
                fontWeight: 600,
                cursor: (dirty && !activeFile?.locked) ? 'pointer' : 'not-allowed',
              }}
            >{saving ? 'saving…' : 'save'}</button>
          </span>
        </div>

        {/* Properties strip */}
        {activeFile && (
          <div style={{
            padding: '6px 12px',
            borderBottom: '1px solid #1f2937',
            background: '#0f141f',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto 1fr auto 1fr',
            gap: 10,
            fontSize: 11,
            color: '#9ca3af',
            alignItems: 'center',
          }}>
            <span style={{ color: '#6b7280' }}>written by</span>
            <span style={{ color: '#e5e7eb' }}>{activeFile.writtenBy.join(', ') || '—'}</span>
            <span style={{ color: '#6b7280' }}>read by</span>
            <span style={{ color: '#e5e7eb' }}>{activeFile.readBy.join(', ') || '—'}</span>
            <span style={{ color: '#6b7280' }}>size · modified</span>
            <span style={{ color: '#e5e7eb', fontFamily: 'ui-monospace, monospace' }}>
              {activeFile.exists ? `${fmtSize(activeFile.size)} · ${fmtAgo(activeFile.mtimeMs)} ago` : 'does not exist yet'}
            </span>
          </div>
        )}

        {/* Monaco */}
        <div style={{ flex: 1, minHeight: 0 }}>
          {loading ? (
            <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>loading…</div>
          ) : active ? (
            <Editor
              height="100%"
              language={activeFile?.language === 'json' || activeFile?.language === 'jsonl' ? 'json' : (activeFile?.language ?? 'markdown')}
              theme="vs-dark"
              value={draft}
              onChange={(v) => setDraft(v ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                wordWrap: 'on',
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                readOnly: activeFile?.locked ?? false,
              }}
            />
          ) : (
            <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>Select a file on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file, active, onClick,
}: {
  file: MemFile;
  active: boolean;
  onClick: () => void;
}) {
  const meta = TIER_META[file.tier];
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: active ? '#1a2332' : 'transparent',
        border: 'none',
        borderLeft: `2px solid ${active ? meta.border : 'transparent'}`,
        borderBottom: '1px solid #161b26',
        color: file.exists ? '#e5e7eb' : '#6b7280',
        fontSize: 11,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11,
          color: file.exists ? '#e5e7eb' : '#6b7280',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{file.path}</span>
        {file.locked && <span style={{ color: '#ef4444', fontSize: 10 }}>🛑</span>}
        {!file.exists && <span style={{ color: '#4b5563', fontSize: 10, fontStyle: 'italic' }}>empty</span>}
      </div>
      <div style={{ fontSize: 10, color: '#6b7280', display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {file.purpose}
        </span>
        {file.exists && (
          <span style={{ fontFamily: 'ui-monospace, monospace', color: '#4b5563' }}>
            {fmtSize(file.size)}
          </span>
        )}
      </div>
    </button>
  );
}
