'use client';

/**
 * /notes — a minimal notes app (owner ask, verbatim: "Build me a small notes
 * app — something where I can jot notes down and search them later. Keep it
 * minimal." owner-ask-batch-2026-07-06 P-004, WI-3265).
 *
 * Deliberately small: a search box, a list of notes, and an editor for the
 * selected note. Rows ride the `notes.list` sync query (server writes fire
 * notifySyncInvalidate('notes.list'), so edits from any surface — including an
 * agent calling the /api/notes routes — appear here live). Search + selection
 * are user-meaningful view state, so both live in the URL via nuqs per repo
 * convention; the mid-edit draft text stays useState.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
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

function titleOf(note: Pick<NoteRow, 'title' | 'body'>): string {
  const t = note.title.trim();
  if (t) return t;
  const firstLine = note.body.trim().split('\n')[0]?.trim();
  return firstLine || 'Untitled note';
}

export default function NotesPage() {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  // Search + selection are URL-backed (nuqs) — deep-linkable, agent-driveable.
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('note', parseAsString);

  const query = q.trim();
  const { data: rows, loading } = useSyncQuery<NoteRow>({
    queryName: 'notes.list',
    args: { query: query || undefined },
  });

  // Mid-edit draft — lifecycle state, stays useState per the repo's nuqs rule.
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  // Load the selected note's content into the draft whenever the selection
  // (or the underlying row, on an external update) changes.
  useEffect(() => {
    if (selected) {
      setDraftTitle(selected.title);
      setDraftBody(selected.body);
      setDirty(false);
    }
  }, [selected?.id, selected?.title, selected?.body]);

  // If the selected id no longer exists (deleted elsewhere), clear it.
  useEffect(() => {
    if (!loading && selectedId && !rows.some((r) => r.id === selectedId)) {
      void setSelectedId(null);
    }
  }, [loading, selectedId, rows, setSelectedId]);

  const onSelect = useCallback((id: string) => {
    void setSelectedId(id);
  }, [setSelectedId]);

  const onNew = useCallback(async () => {
    setCreating(true);
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '', body: '' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.note?.id) {
        void setSelectedId(j.note.id);
      } else {
        toast.error('Could not create note');
      }
    } finally {
      setCreating(false);
    }
  }, [setSelectedId]);

  const onSave = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const r = await fetch('/api/notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId, title: draftTitle, body: draftBody }),
      });
      if (r.ok) {
        setDirty(false);
      } else {
        toast.error('Save failed');
      }
    } finally {
      setSaving(false);
    }
  }, [selectedId, draftTitle, draftBody]);

  // Autosave shortly after the user stops typing — a notes app shouldn't
  // require a manual save step to not lose work.
  useEffect(() => {
    if (!dirty || !selectedId) return;
    const t = setTimeout(() => { void onSave(); }, 600);
    return () => clearTimeout(t);
  }, [dirty, selectedId, onSave]);

  const onDelete = useCallback(async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this note?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/notes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.ok) {
      if (selectedId === id) void setSelectedId(null);
      toast.success('Note deleted');
    } else {
      toast.error('Delete failed');
    }
  }, [askConfirm, selectedId, setSelectedId]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: '100vh' }}>
      {confirmEl}
      <div
        style={{
          width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border)', background: 'var(--bg-2)',
        }}
      >
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h1 style={{ margin: 0, fontSize: 16 }}>Notes</h1>
            <button
              type="button"
              onClick={() => void onNew()}
              disabled={creating}
              style={{
                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--bg-3)', cursor: creating ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >
              ＋ New
            </button>
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => void setQ(e.target.value || null)}
            placeholder="Search notes…"
            aria-label="Search notes"
            style={{
              padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--bg-3)', color: 'var(--fg)', fontSize: 13,
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {loading ? (
            <p style={{ padding: 8, color: 'var(--fg-mute)', fontSize: 13 }}>Loading…</p>
          ) : rows.length === 0 ? (
            <p style={{ padding: 8, color: 'var(--fg-mute)', fontSize: 13 }}>
              {query ? `No notes matching “${query}”.` : 'No notes yet — click “＋ New” to jot one down.'}
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {rows.map((row) => {
                const isActive = row.id === selectedId;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(row.id)}
                      style={{
                        width: '100%', textAlign: 'left', padding: 8, borderRadius: 6,
                        border: isActive ? '2px solid var(--fg)' : '1px solid transparent',
                        background: isActive ? 'var(--bg-3)' : 'transparent',
                        cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {titleOf(row)}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--fg-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {timeAgo(row.updated_at)}
                        {row.body.trim() && ` · ${row.body.trim().slice(0, 60)}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {!selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-mute)' }}>
            Select a note, or create a new one.
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24, gap: 12, maxWidth: 760 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
                {saving ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved ${timeAgo(selected.updated_at)}`}
              </span>
              <button
                type="button"
                onClick={() => void onDelete(selected.id)}
                style={{
                  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bad)',
                  color: 'var(--bad)', background: 'transparent', cursor: 'pointer', fontSize: 12,
                }}
              >
                Delete
              </button>
            </div>
            <input
              value={draftTitle}
              onChange={(e) => { setDraftTitle(e.target.value); setDirty(true); }}
              placeholder="Title"
              aria-label="Note title"
              style={{
                fontSize: 20, fontWeight: 700, padding: '4px 0', border: 'none',
                borderBottom: '1px solid var(--border)', background: 'transparent',
                color: 'var(--fg)', outline: 'none',
              }}
            />
            <textarea
              value={draftBody}
              onChange={(e) => { setDraftBody(e.target.value); setDirty(true); }}
              placeholder="Write your note…"
              aria-label="Note body"
              style={{
                flex: 1, resize: 'none', padding: '8px 0', border: 'none', outline: 'none',
                background: 'transparent', color: 'var(--fg)', fontSize: 14, fontFamily: 'inherit',
                lineHeight: 1.5, minHeight: 300,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
