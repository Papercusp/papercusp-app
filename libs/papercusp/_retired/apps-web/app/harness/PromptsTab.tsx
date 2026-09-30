'use client';

import { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Trash2, Loader2, Globe, User } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  slug: string;
  alive: boolean;
}

type Scope = 'global' | 'override';

interface RoleData {
  content: string;          // project override (may be empty)
  globalContent: string;    // global base (read-only)
  overrideExists: boolean;
}

export default function PromptsTab({ slug, alive }: Props) {
  const [roles, setRoles] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ role: string; scope: Scope } | null>(null);

  const [data, setData] = useState<RoleData | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [originalOverride, setOriginalOverride] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const reloadList = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/prompts`).then((r) => r.json());
      setRoles(r.roles ?? []);
      setOverrides(r.overrides ?? []);
    } catch {}
  }, [slug]);

  useEffect(() => { reloadList(); }, [reloadList]);

  // Default selection: orchestrator / global (most common starting point)
  useEffect(() => {
    if (!selected && roles.length > 0) {
      const first = roles.includes('orchestrator') ? 'orchestrator' : roles[0];
      setSelected({ role: first, scope: 'global' });
    }
  }, [roles, selected]);

  // Load role data when selected role changes
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/harness/${slug}/prompts/${selected.role}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const content = typeof d.content === 'string' ? d.content : '';
        const globalContent = typeof d.globalContent === 'string' ? d.globalContent : '';
        setData({ content, globalContent, overrideExists: !!d.overrideExists });
        setDraft(content);
        setOriginalOverride(content);
      })
      .catch((e) => toast.error(`load failed: ${e.message ?? e}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug, selected?.role]);

  const dirty = selected?.scope === 'override' && draft !== originalOverride;

  const saveOverride = useCallback(async () => {
    if (!selected || selected.scope !== 'override' || !dirty) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/harness/${slug}/prompts/${selected.role}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOriginalOverride(draft);
      setData((d) => d ? { ...d, content: draft, overrideExists: true } : d);
      toast.success(`saved ${selected.role} override`);
      reloadList();
    } catch (e: any) {
      toast.error(`save failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }, [slug, selected, dirty, draft, reloadList]);

  const deleteOverride = useCallback(async () => {
    if (!selected || selected.scope !== 'override' || !data?.overrideExists) return;
    if (!confirm(`Delete ${selected.role} override? This reverts to the global base.`)) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/harness/${slug}/prompts/${selected.role}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      toast.success(`deleted ${selected.role} override`);
      setData((d) => d ? { ...d, content: '', overrideExists: false } : d);
      setDraft('');
      setOriginalOverride('');
      reloadList();
    } catch (e: any) {
      toast.error(`delete failed: ${e.message ?? e}`);
    } finally {
      setDeleting(false);
    }
  }, [slug, selected, data, reloadList]);

  // Ctrl/Cmd+S saves when on override scope
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (selected?.scope === 'override' && dirty) {
          e.preventDefault();
          saveOverride();
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected, dirty, saveOverride]);

  const scope = selected?.scope ?? 'global';
  const editorValue = !data
    ? ''
    : scope === 'global'
      ? data.globalContent
      : draft;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* ─── Sidebar: two grouped sections ─── */}
      <div style={{
        width: 240, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column',
        overflow: 'auto',
      }}>
        <SidebarSection
          title="Global (read-only)"
          icon={<Globe size={11} />}
          roles={roles}
          selected={selected}
          scope="global"
          overrides={overrides}
          onSelect={(role) => setSelected({ role, scope: 'global' })}
        />
        <SidebarSection
          title={`Project overrides · ${overrides.length}`}
          icon={<User size={11} />}
          roles={roles}
          selected={selected}
          scope="override"
          overrides={overrides}
          onSelect={(role) => setSelected({ role, scope: 'override' })}
        />
      </div>

      {/* ─── Editor ─── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!selected ? (
          <div className="h-empty">select a role on the left</div>
        ) : (
          <>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8,
              flexShrink: 0, background: 'var(--bg-2)',
            }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {selected.role}
              </span>
              <span style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 3,
                background: scope === 'global' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                color: scope === 'global' ? '#60a5fa' : '#34d399',
                border: `1px solid ${scope === 'global' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
              }}>
                {scope === 'global' ? 'global · read-only' : 'project override'}
              </span>
              {dirty && <span style={{ color: 'var(--warn)', fontSize: 16, lineHeight: 1 }}>●</span>}
              {loading && <Loader2 size={12} className="h-spin" />}
              {scope === 'override' && !data?.overrideExists && !dirty && (
                <span style={{ fontSize: 10.5, color: 'var(--fg-dim)' }}>
                  (no override yet — type to create one)
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {scope === 'override' && data?.overrideExists && (
                  <button className="h-btn ghost" onClick={deleteOverride} disabled={deleting} title="Delete override → revert to global base">
                    <Trash2 size={11} /> delete override
                  </button>
                )}
                {scope === 'override' && (
                  <button className="h-btn primary" onClick={saveOverride} disabled={!dirty || saving}>
                    {saving ? 'saving…' : 'save'}
                  </button>
                )}
              </div>
            </div>
            {scope === 'global' && (
              <div style={{
                padding: '6px 16px',
                background: 'rgba(59, 130, 246, 0.08)',
                borderBottom: '1px solid rgba(59, 130, 246, 0.2)',
                fontSize: 11.5, color: '#93c5fd',
              }}>
                Base prompt at <code style={{ fontFamily: 'ui-monospace, monospace' }}>~/autonomous-harness/prompts/{selected.role}.md</code>.
                Read-only from the UI because changes apply to every project — edit the file directly if that is what you intend.
              </div>
            )}
            {alive && scope === 'override' && (
              <div style={{
                padding: '6px 16px',
                background: 'rgba(245, 158, 11, 0.08)',
                borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
                fontSize: 11.5, color: '#fbbf24',
              }}>
                ⚠ harness is running — edits take effect on the next agent invocation
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <Editor
                height="100%"
                language="markdown"
                theme="vs-dark"
                value={editorValue}
                onChange={(v) => setDraft(v ?? '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12.5,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  readOnly: scope === 'global',
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SidebarSection({
  title, icon, roles, selected, scope, overrides, onSelect,
}: {
  title: string;
  icon: React.ReactNode;
  roles: string[];
  selected: { role: string; scope: Scope } | null;
  scope: Scope;
  overrides: string[];
  onSelect: (role: string) => void;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div style={{
        padding: '8px 10px',
        fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase',
        color: 'var(--fg-dim)', fontWeight: 600,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {icon} {title}
      </div>
      {roles.map((role) => {
        const isActive = selected?.role === role && selected?.scope === scope;
        const hasOverride = overrides.includes(role);
        return (
          <button
            key={`${scope}-${role}`}
            onClick={() => onSelect(role)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              width: '100%', textAlign: 'left',
              padding: '7px 10px 7px 22px',
              background: isActive ? 'var(--bg-3)' : 'transparent',
              color: scope === 'override' && !hasOverride ? 'var(--fg-dim)' : 'var(--fg)',
              border: 'none',
              borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 60%)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            <span>{role}</span>
            {scope === 'override' && hasOverride && (
              <span style={{ color: 'var(--good)', fontSize: 9, marginLeft: 'auto' }}>●</span>
            )}
            {scope === 'override' && !hasOverride && (
              <span style={{ color: 'var(--fg-dim)', fontSize: 9, marginLeft: 'auto' }}>—</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
