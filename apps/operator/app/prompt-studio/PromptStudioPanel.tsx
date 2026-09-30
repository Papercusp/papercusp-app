'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Select } from '../harness/Select';

/**
 * PromptStudioPanel — edit the `renderSuPlaybook` SOURCES with a live preview of the
 * assembled per-client psu prompt (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09
 * P-011). Edits the SOURCES (base playbooks / per-client overlays / project-guide),
 * never the generated `~/.papercusp/*-collaborator*.md` (those regenerate).
 *
 * Backed by the `/api/prompt-studio/*` routes:
 *   - sources list + read (left: source picker + editor),
 *   - preview (right: pick agent×profile → the assembled prompt, exactly as a launch composes it),
 *   - save (PUT — writes the staging-tree source; git-sync → green-checkpoint → deploy carries it,
 *     so a save rides the staging→deploy pipeline, never a live hot-edit).
 *
 * Flag-gated behind `PROMPT_STUDIO` (default off). Mount point: the global/hive settings
 * nav — DEFERRED to coordinate with the in-flight /settings restructure; this component is
 * ready to drop in once that lands. Self-contained: no harness scope.
 */

const AGENTS = ['claude', 'omp', 'codex'] as const;
const PROFILES = ['engineer', 'power'] as const;

interface SourceMeta {
  id: string;
  label: string;
  kind: string;
}

export default function PromptStudioPanel() {
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [dir, setDir] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [loadingSource, setLoadingSource] = useState(false);
  const [saving, setSaving] = useState(false);

  const [previewAgent, setPreviewAgent] = useState<(typeof AGENTS)[number]>('claude');
  const [previewProfile, setPreviewProfile] = useState<(typeof PROFILES)[number]>('engineer');
  const [preview, setPreview] = useState<{ text: string; chars: number; projectGuideSource: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Source list on mount.
  useEffect(() => {
    let cancel = false;
    fetch('/api/prompt-studio/sources')
      .then((r) => r.json())
      .then((d: { dir?: string; sources?: SourceMeta[] }) => {
        if (cancel) return;
        setSources(d.sources ?? []);
        setDir(d.dir ?? '');
        if (d.sources?.length && !selectedId) setSelectedId(d.sources[0].id);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the selected source's content.
  useEffect(() => {
    if (!selectedId) return;
    let cancel = false;
    setLoadingSource(true);
    fetch(`/api/prompt-studio/source?id=${encodeURIComponent(selectedId)}`)
      .then((r) => r.json())
      .then((d: { content?: string }) => {
        if (cancel) return;
        setContent(d.content ?? '');
        setSavedContent(d.content ?? '');
      })
      .catch(() => {})
      .finally(() => {
        if (!cancel) setLoadingSource(false);
      });
    return () => {
      cancel = true;
    };
  }, [selectedId]);

  const refreshPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const r = await fetch(`/api/prompt-studio/preview?agent=${previewAgent}&profile=${previewProfile}`);
      const d = (await r.json()) as { text?: string; chars?: number; projectGuideSource?: string; error?: string };
      if (d.error) throw new Error(d.error);
      setPreview({ text: d.text ?? '', chars: d.chars ?? 0, projectGuideSource: d.projectGuideSource ?? '' });
    } catch (e) {
      toast.error('Preview failed', { description: (e as Error).message });
    } finally {
      setPreviewLoading(false);
    }
  }, [previewAgent, previewProfile]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  const dirty = content !== savedContent;

  const save = useCallback(async () => {
    if (!selectedId || !dirty) return;
    setSaving(true);
    try {
      const r = await fetch('/api/prompt-studio/source', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selectedId, content }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string; note?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setSavedContent(content);
      toast.success('Saved', { description: d.note ?? 'rides the staging→deploy pipeline' });
      void refreshPreview();
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [selectedId, content, dirty, refreshPreview]);

  const sourceOptions = useMemo(() => sources.map((s) => ({ value: s.id, label: s.label })), [sources]);

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Prompt Studio</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Edit the psu prompt <strong>sources</strong> (base playbooks, per-client overlays, project
          guide) and preview the assembled per-client prompt. Saves write the staging tree; the change
          reaches the live render through the staging→deploy pipeline. {dir ? <code>{dir}</code> : null}
        </p>
      </header>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* ── Editor ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-mute)' }}>Source</span>
            <Select value={selectedId} onChange={(v) => setSelectedId(v)} options={sourceOptions} />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || loadingSource}
              style={{ fontSize: 12, padding: '5px 14px', cursor: !dirty || saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {dirty && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>unsaved</span>}
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            disabled={loadingSource}
            style={{
              flex: 1,
              minHeight: 0,
              width: '100%',
              fontSize: 12,
              fontFamily: 'monospace',
              padding: 10,
              lineHeight: 1.5,
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'inherit',
              resize: 'none',
            }}
          />
        </div>

        {/* ── Live preview ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-mute)' }}>Preview</span>
            <Select
              value={previewAgent}
              onChange={(v) => setPreviewAgent(v as (typeof AGENTS)[number])}
              options={AGENTS.map((a) => ({ value: a, label: a }))}
            />
            <Select
              value={previewProfile}
              onChange={(v) => setPreviewProfile(v as (typeof PROFILES)[number])}
              options={PROFILES.map((p) => ({ value: p, label: p }))}
            />
            <button type="button" onClick={() => void refreshPreview()} disabled={previewLoading} style={{ fontSize: 11, padding: '4px 10px' }}>
              {previewLoading ? '…' : 'Refresh'}
            </button>
            {preview && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{preview.chars.toLocaleString()} chars</span>}
          </div>
          <pre
            style={{
              flex: 1,
              minHeight: 0,
              margin: 0,
              fontSize: 11.5,
              fontFamily: 'monospace',
              padding: 10,
              lineHeight: 1.5,
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--fg-mute)',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {preview?.text ?? (previewLoading ? 'Rendering…' : 'No preview')}
          </pre>
        </div>
      </div>
    </div>
  );
}
