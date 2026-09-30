'use client';

import { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export interface CollectionItem {
  id: string;       // canonical id ("planner", "deploy-skill", etc.)
  label: string;    // display label
  subtitle?: string;
  exists: boolean;  // whether file exists on disk
  kind?: 'override' | 'builtin';
}

interface Props {
  slug: string;
  collection: 'skills' | 'prompts';
  items: CollectionItem[];
  reloadItems: () => void;
  // Given an id, returns the API url for GET/PUT/DELETE.
  itemUrl: (id: string) => string;
  // UI customization
  language?: 'markdown' | 'json';
  createLabel?: string;
  allowCreate?: boolean;  // skills: yes; prompts: roles are fixed
  deletable?: (item: CollectionItem) => boolean;
  // For prompts: show "global" content as placeholder for missing overrides
  fallbackKey?: string;
  disabled?: boolean;
}

export function CollectionTab({
  slug, collection, items, reloadItems, itemUrl,
  language = 'markdown',
  createLabel = '+ new',
  allowCreate = false,
  deletable,
  fallbackKey = 'globalContent',
  disabled,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [original, setOriginal] = useState<string>('');
  const [fallback, setFallback] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Default to first item
  useEffect(() => {
    if (selectedId === null && items.length > 0) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const dirty = draft !== original;

  const loadItem = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const r = await fetch(itemUrl(id));
      const d = await r.json();
      const content = typeof d.content === 'string' ? d.content : '';
      setDraft(content);
      setOriginal(content);
      setFallback(typeof d[fallbackKey] === 'string' ? d[fallbackKey] : '');
    } catch (e: any) {
      toast.error(`Load failed: ${e.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, [itemUrl, fallbackKey]);

  useEffect(() => {
    if (selectedId) loadItem(selectedId);
  }, [selectedId, loadItem]);

  const save = useCallback(async () => {
    if (!selectedId || !dirty) return;
    setSaving(true);
    try {
      const r = await fetch(itemUrl(selectedId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOriginal(draft);
      toast.success(`saved ${selectedId}`);
      reloadItems();
    } catch (e: any) {
      toast.error(`Save failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }, [selectedId, dirty, draft, itemUrl, reloadItems]);

  const remove = useCallback(async () => {
    if (!selectedId) return;
    if (!confirm(`Delete ${collection === 'skills' ? 'skill' : 'override'} "${selectedId}"?`)) return;
    setDeleting(true);
    try {
      const r = await fetch(itemUrl(selectedId), { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      toast.success(`deleted ${selectedId}`);
      const remaining = items.filter((i) => i.id !== selectedId);
      setSelectedId(remaining.length > 0 ? remaining[0].id : null);
      setDraft('');
      setOriginal('');
      reloadItems();
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message ?? e}`);
    } finally {
      setDeleting(false);
    }
  }, [selectedId, itemUrl, items, reloadItems, collection]);

  const createNew = useCallback(async () => {
    const name = prompt(`New ${collection === 'skills' ? 'skill' : 'override'} name (lowercase-dash, no extension):`);
    if (!name) return;
    const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    if (!cleaned) return toast.error('invalid name');
    setSelectedId(cleaned);
    setDraft('');
    setOriginal('');
  }, [collection]);

  // ⌘S to save
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

  const selected = items.find((i) => i.id === selectedId);
  const showFallback = !loading && !original && fallback;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Sidebar */}
      <div style={{
        width: 220, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: 600 }}>
            {collection} · {items.filter((i) => i.exists).length}
          </span>
          {allowCreate && !disabled && (
            <button
              onClick={createNew}
              className="h-btn ghost"
              style={{ marginLeft: 'auto', padding: '2px 7px', fontSize: 10 }}
            >
              <Plus size={10} /> {createLabel}
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {items.length === 0 && (
            <div className="h-empty" style={{ padding: 16, fontSize: 11 }}>
              no {collection} yet
            </div>
          )}
          {items.map((item) => {
            const isActive = item.id === selectedId;
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: isActive ? 'var(--bg-3)' : 'transparent',
                  color: item.exists ? 'var(--fg)' : 'var(--fg-dim)',
                  border: 'none',
                  borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 60%)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                <div>
                  {item.label}
                  {!item.exists && <span style={{ color: 'var(--fg-dim)', fontSize: 9, marginLeft: 6 }}>(no override)</span>}
                  {item.exists && <span style={{ color: 'var(--good)', fontSize: 9, marginLeft: 6 }}>●</span>}
                </div>
                {item.subtitle && (
                  <div style={{ fontSize: 9.5, color: 'var(--fg-dim)', marginTop: 1 }}>
                    {item.subtitle}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!selected ? (
          <div className="h-empty">select or create an item on the left</div>
        ) : (
          <>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8,
              flexShrink: 0, background: 'var(--bg-2)',
            }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {selected.id}
              </span>
              {dirty && <span style={{ color: 'var(--warn)', fontSize: 16, lineHeight: 1 }}>●</span>}
              {loading && <Loader2 size={12} className="h-spin" />}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {selected.exists && deletable?.(selected) !== false && !disabled && (
                  <button className="h-btn ghost" onClick={remove} disabled={deleting} title="Delete this file">
                    <Trash2 size={11} /> delete
                  </button>
                )}
                <button className="h-btn primary" onClick={save} disabled={!dirty || saving || disabled}>
                  {saving ? 'saving…' : 'save'}
                </button>
              </div>
            </div>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              <Editor
                height="100%"
                language={language}
                theme="vs-dark"
                value={draft}
                onChange={(v) => setDraft(v ?? '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12.5,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  readOnly: disabled,
                }}
              />
              {showFallback && (
                <div style={{
                  position: 'absolute', top: 10, right: 10,
                  background: 'var(--bg-3)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '4px 8px', fontSize: 10,
                  color: 'var(--fg-dim)', maxWidth: 280,
                }}>
                  no override — inheriting the global {selected.id}. Start typing to create one.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
