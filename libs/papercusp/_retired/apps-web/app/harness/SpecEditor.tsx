'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import MemoryBrowser from './MemoryBrowser';
import PromptsTab from './PromptsTab';
import { CollectionTab, type CollectionItem } from './CollectionTab';

type SimpleTab = 'spec' | 'agents' | 'contract' | 'config' | 'knowledge' | 'mcp' | 'supervisor' | 'claudeSettings' | 'env';
type Tab = SimpleTab | 'skills';

type TabKind = 'file' | 'collection';
type Sensitivity = 'normal' | 'warn' | 'secret';

type Section = 'settings' | 'memory' | 'prompts';

const TABS: Array<{ id: Tab; label: string; filename: string; path: (projectPath: string) => string; language: 'markdown' | 'json'; kind: TabKind; sensitivity?: Sensitivity }> = [
  { id: 'spec',            label: 'SPEC.md',                 filename: 'SPEC.md',              path: (p) => `${p}/SPEC.md`,                        language: 'markdown', kind: 'file' },
  { id: 'agents',          label: 'AGENTS.md',               filename: 'AGENTS.md',            path: (p) => `${p}/AGENTS.md`,                      language: 'markdown', kind: 'file' },
  { id: 'contract',        label: 'validation-contract.md',  filename: 'validation-contract.md', path: (p) => `${p}/.papercusp/validation-contract.md`, language: 'markdown', kind: 'file' },
  { id: 'config',          label: 'config.json',             filename: 'config.json',          path: (p) => `${p}/.papercusp/config.json`,            language: 'json',    kind: 'file' },
  { id: 'mcp',             label: '.mcp.json',               filename: '.mcp.json',            path: (p) => `${p}/.mcp.json`,                       language: 'json',    kind: 'file' },
  { id: 'claudeSettings',  label: '.claude/settings.json',   filename: 'settings.json',        path: (p) => `${p}/.claude/settings.json`,           language: 'json',    kind: 'file', sensitivity: 'warn' },
  { id: 'skills',          label: 'skills',                  filename: '',                     path: (p) => `${p}/.claude/skills/`,                 language: 'markdown', kind: 'collection' },
  { id: 'supervisor',      label: 'supervisor-notes.md',     filename: 'supervisor-notes.md',  path: (p) => `${p}/.papercusp/supervisor-notes.md`,    language: 'markdown', kind: 'file' },
  { id: 'knowledge',       label: 'knowledge.md',            filename: 'knowledge.md',         path: (p) => `${p}/.papercusp/knowledge.md`,           language: 'markdown', kind: 'file' },
  { id: 'env',             label: '.env',                    filename: '.env',                 path: (p) => `${p}/.env`,                            language: 'markdown', kind: 'file', sensitivity: 'secret' },
];

const SIMPLE_TABS: readonly SimpleTab[] = ['spec', 'agents', 'contract', 'config', 'knowledge', 'mcp', 'supervisor', 'claudeSettings', 'env'] as const;

interface Props {
  slug: string;
  projectPath: string;
  alive: boolean;
  onClose: () => void;
  inline?: boolean;
}

export default function SpecEditor({ slug, projectPath, alive, onClose, inline = false }: Props) {
  const [section, setSection] = useState<Section>('settings');
  const [tab, setTab] = useState<Tab>('spec');
  const [original, setOriginal] = useState<Record<SimpleTab, string | null>>({ spec: null, agents: null, contract: null, config: null, knowledge: null, mcp: null, supervisor: null, claudeSettings: null, env: null });
  const [draft, setDraft] = useState<Record<SimpleTab, string>>({ spec: '', agents: '', contract: '', config: '', knowledge: '', mcp: '', supervisor: '', claudeSettings: '', env: '' });
  const [envRevealed, setEnvRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Skills is a collection — managed by CollectionTab below.
  // Prompts are managed by PromptsTab under its own section.
  const [skills, setSkills] = useState<string[]>([]);

  const reloadSkills = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/skills`).then((r) => r.json());
      setSkills(d.skills ?? []);
    } catch {}
  }, [slug]);

  // Load content when opened.
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/harness/${slug}/spec`).then((r) => r.json()),
      fetch(`/api/harness/${slug}/knowledge`).then((r) => r.json()),
      fetch(`/api/harness/${slug}/mcp`).then((r) => r.json()),
      fetch(`/api/harness/${slug}/supervisor-notes`).then((r) => r.json()),
      fetch(`/api/harness/${slug}/claude-settings`).then((r) => r.json()),
      // .env is NOT preloaded — only fetched after user reveals it.
    ])
      .then(([d, k, m, s, cs]) => {
        const o: Record<SimpleTab, string | null> = {
          spec: d.spec ?? null,
          agents: d.agents ?? null,
          contract: d.contract ?? null,
          config: d.config ?? null,
          knowledge: k.content ?? null,
          mcp: m.content || null,
          supervisor: s.content || null,
          claudeSettings: cs.content || null,
          env: null,
        };
        setOriginal(o);
        setDraft({
          spec: o.spec ?? '',
          agents: o.agents ?? '',
          contract: o.contract ?? '',
          config: o.config ?? '',
          knowledge: o.knowledge ?? '',
          mcp: o.mcp ?? '',
          supervisor: o.supervisor ?? '',
          claudeSettings: o.claudeSettings ?? '',
          env: '',
        });
      })
      .catch((e) => setToast(`load failed: ${e}`))
      .finally(() => setLoading(false));
    reloadSkills();
  }, [slug, reloadSkills]);

  const dirty = useMemo(() => {
    const diffs: SimpleTab[] = [];
    for (const t of SIMPLE_TABS) {
      if ((original[t] ?? '') !== draft[t]) diffs.push(t);
    }
    return diffs;
  }, [original, draft]);

  const tabKind = TABS.find((t) => t.id === tab)?.kind ?? 'file';
  const isCollectionTab = tabKind === 'collection';
  const onSettings = section === 'settings';

  const save = useCallback(async () => {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const written: string[] = [];

      // /spec handles spec/agents/contract/config in one call
      const specDirty = dirty.filter((t) => ['spec', 'agents', 'contract', 'config'].includes(t));
      if (specDirty.length > 0) {
        const body: Record<string, string> = {};
        for (const t of specDirty) body[t] = draft[t];
        const res = await fetch(`/api/harness/${slug}/spec`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const j = await res.json();
        written.push(...(j.written ?? []));
      }

      // Single-file endpoints
      const singles: Array<[SimpleTab, string, Record<string, string>?]> = [
        ['knowledge',      `/api/harness/${slug}/knowledge`],
        ['mcp',            `/api/harness/${slug}/mcp`],
        ['supervisor',     `/api/harness/${slug}/supervisor-notes`],
        ['claudeSettings', `/api/harness/${slug}/claude-settings`],
        ['env',            `/api/harness/${slug}/env`, { 'x-confirm-secrets': 'yes' }],
      ];
      for (const [t, url, extraHeaders] of singles) {
        if (!dirty.includes(t)) continue;
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
          body: JSON.stringify({ content: draft[t] }),
        });
        if (!res.ok) throw new Error(`${t}: ${res.status}: ${await res.text()}`);
        written.push(t);
      }

      setOriginal({ ...original, ...Object.fromEntries(dirty.map((t) => [t, draft[t]])) });
      setToast(`saved: ${written.join(', ')}`);
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, original, slug]);

  // Lazy-load .env only after user reveals it
  const revealEnv = useCallback(async () => {
    if (envRevealed) return;
    if (!confirm('Show .env contents?\n\nThis loads plaintext secrets into the browser tab. Only do this on a machine you trust and close the tab when done.')) return;
    try {
      const d = await fetch(`/api/harness/${slug}/env`).then((r) => r.json());
      setOriginal((o) => ({ ...o, env: d.content ?? null }));
      setDraft((d2) => ({ ...d2, env: d.content ?? '' }));
      setEnvRevealed(true);
    } catch (e) {
      setToast(`env load failed: ${e}`);
    }
  }, [envRevealed, slug]);

  const revertActive = useCallback(() => {
    if (SIMPLE_TABS.includes(tab as SimpleTab)) {
      const t = tab as SimpleTab;
      setDraft((d) => ({ ...d, [t]: original[t] ?? '' }));
    }
  }, [original, tab]);

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

  const tabMeta = TABS.find((t) => t.id === tab)!;
  const simpleTab = SIMPLE_TABS.includes(tab as SimpleTab) ? (tab as SimpleTab) : null;
  const missing = simpleTab ? original[simpleTab] === null : false;
  const isDirtyTab = simpleTab ? dirty.includes(simpleTab) : false;
  const needsEnvReveal = tab === 'env' && !envRevealed;
  const sensitivity = tabMeta.sensitivity;

  const inner = (
    <div
      style={{
        background: '#0b0e14',
        border: inline ? 'none' : '1px solid #374151',
        borderRadius: inline ? 0 : 6,
        width: inline ? '100%' : '90vw',
        // Inline: use flex:1 + align-self:stretch so we fill the parent
        // (.h-config-body) regardless of its flex direction. `height: 100%`
        // doesn't resolve reliably when the parent's height comes from
        // `flex: 1 1 0%` rather than an explicit value.
        ...(inline ? { flex: 1, alignSelf: 'stretch', minHeight: 0 } : { height: '90vh' }),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: '#e5e7eb' }}>Edit config — {slug}</strong>
          {onSettings && (
            <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>{tabMeta.path(projectPath)}</span>
          )}
          {alive && (
            <span style={{ color: '#f59e0b', fontSize: '0.8rem', marginLeft: '1rem' }}>
              ⚠ harness is running — edits take effect on the next agent invocation
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            {toast && (
              <span style={{ color: toast.startsWith('saved') ? '#10b981' : '#ef4444', fontSize: '0.8rem', alignSelf: 'center' }}>
                {toast}
              </span>
            )}
            {onSettings && !isCollectionTab && (
              <>
                <button
                  onClick={revertActive}
                  disabled={!isDirtyTab}
                  style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: isDirtyTab ? 'pointer' : 'not-allowed', opacity: isDirtyTab ? 1 : 0.5 }}
                  title="Revert active tab to last-saved state"
                >
                  revert tab
                </button>
                <button
                  onClick={save}
                  disabled={dirty.length === 0 || saving}
                  style={{ background: dirty.length ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: dirty.length ? 'pointer' : 'not-allowed', fontWeight: 600 }}
                  title="Save all dirty files (⌘/Ctrl+S)"
                >
                  {saving ? 'saving…' : `save${dirty.length ? ` (${dirty.length})` : ''}`}
                </button>
              </>
            )}
            <button
              onClick={onClose}
              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
            >
              close
            </button>
          </div>
        </div>

        {/* Section tabs: Settings / Memory / Prompts */}
        <div style={{ display: 'flex', gap: '0.35rem', padding: '0.5rem 1rem', borderBottom: '1px solid #1f2937', background: '#0b1018' }}>
          {(['settings', 'memory', 'prompts'] as const).map((s) => {
            const isActive = section === s;
            const label = s === 'settings' ? 'Settings' : s === 'memory' ? 'Memory' : 'Prompts';
            return (
              <button
                key={s}
                onClick={() => setSection(s)}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? '#e5e7eb' : '#9ca3af',
                  border: '1px solid ' + (isActive ? '#4b5563' : 'transparent'),
                  borderRadius: 4,
                  padding: '0.4rem 0.9rem',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Sub-tabs (only within Settings) */}
        {onSettings && (
          <div style={{ display: 'flex', gap: '0.25rem', padding: '0.35rem 1rem', borderBottom: '1px solid #1f2937', background: '#0f141f', flexWrap: 'wrap' }}>
            {TABS.map((t) => {
              const isActive = t.id === tab;
              const isSimple = SIMPLE_TABS.includes(t.id as SimpleTab);
              const isDirty = isSimple && dirty.includes(t.id as SimpleTab);
              const doesntExist = isSimple && original[t.id as SimpleTab] === null;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    background: isActive ? '#1f2937' : 'transparent',
                    color: isActive ? '#e5e7eb' : '#9ca3af',
                    border: '1px solid ' + (isActive ? '#374151' : 'transparent'),
                    borderRadius: 3,
                    padding: '0.3rem 0.75rem',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  {t.label}
                  {isDirty && <span style={{ color: '#f59e0b', marginLeft: 6 }}>●</span>}
                  {doesntExist && !isDirty && <span style={{ color: '#6b7280', marginLeft: 6, fontSize: '0.7rem' }}>(new)</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Sensitivity banner (settings only) */}
        {onSettings && sensitivity === 'warn' && (
          <div style={{ padding: '6px 16px', background: 'rgba(245, 158, 11, 0.1)', borderBottom: '1px solid rgba(245, 158, 11, 0.3)', fontSize: 11.5, color: '#fbbf24' }}>
            ⚠ Editing {tabMeta.label} changes Claude's tool permissions and environment for this project. Malformed JSON will break `claude -p` on the next agent run — JSON is validated before save, but semantics are on you.
          </div>
        )}
        {onSettings && sensitivity === 'secret' && (
          <div style={{ padding: '6px 16px', background: 'rgba(239, 68, 68, 0.1)', borderBottom: '1px solid rgba(239, 68, 68, 0.3)', fontSize: 11.5, color: '#fca5a5' }}>
            🔒 .env contains secrets. Opening this tab loads plaintext into browser memory. Close the tab when done. Saving requires a confirmation header — drive-by form submits will reject.
          </div>
        )}

        {/* Editor */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {section === 'memory' ? (
            <MemoryBrowser slug={slug} alive={alive} />
          ) : section === 'prompts' ? (
            <PromptsTab slug={slug} alive={alive} />
          ) : needsEnvReveal ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: '#9ca3af' }}>
              <span style={{ fontSize: 32 }}>🔒</span>
              <div style={{ fontSize: 13 }}>.env is not loaded until you explicitly reveal it.</div>
              <button onClick={revealEnv} className="h-btn primary" style={{ padding: '6px 16px', fontSize: 12 }}>
                Reveal .env
              </button>
              <div style={{ fontSize: 10, color: '#6b7280', maxWidth: 340, textAlign: 'center', marginTop: 4 }}>
                Secrets will load into browser memory. Close this tab when finished.
              </div>
            </div>
          ) : isCollectionTab && tab === 'skills' ? (
            <CollectionTab
              slug={slug}
              collection="skills"
              items={skills.map((f): CollectionItem => ({
                id: f.replace(/\.md$/, ''),
                label: f,
                exists: true,
              }))}
              reloadItems={reloadSkills}
              itemUrl={(id) => `/api/harness/${slug}/skills/${id}.md`}
              language="markdown"
              allowCreate
              createLabel="new skill"
              deletable={() => true}
            />
          ) : loading ? (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>loading…</div>
          ) : simpleTab ? (
            <div style={{ position: 'absolute', inset: 0 }}>
              <Editor
                height="100%"
                language={tabMeta.language}
                theme="vs-dark"
                value={draft[simpleTab]}
                onChange={(v) => setDraft((d) => ({ ...d, [simpleTab]: v ?? '' }))}
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
            </div>
          ) : null}
          {onSettings && missing && simpleTab && !dirty.includes(simpleTab) && !isCollectionTab && (
            <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: '#111827', border: '1px solid #374151', padding: '0.35rem 0.65rem', borderRadius: 3, fontSize: '0.75rem', color: '#9ca3af' }}>
              file doesn&apos;t exist yet — first save creates it
            </div>
          )}
        </div>
      </div>
  );

  if (inline) return inner;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      {inner}
    </div>
  );
}
