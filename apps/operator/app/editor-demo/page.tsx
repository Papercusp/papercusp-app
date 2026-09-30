'use client';

import { useState, useMemo } from 'react';
import dynamic from '@/lib/router-compat/dynamic';
import { SPEC_CONTENT } from './spec-content';
import { Checkbox } from '../harness/Checkbox';

const MonacoPane     = dynamic(() => import('./panes/MonacoPane'),     { ssr: false, loading: () => <Loading name="Monaco" /> });
const CodeMirrorPane = dynamic(() => import('./panes/CodeMirrorPane'), { ssr: false, loading: () => <Loading name="CodeMirror 6" /> });
const MilkdownPane   = dynamic(() => import('./panes/MilkdownPane'),   { ssr: false, loading: () => <Loading name="Milkdown" /> });
const TiptapPane     = dynamic(() => import('./panes/TiptapPane'),     { ssr: false, loading: () => <Loading name="Tiptap" /> });
const UiwMdPane      = dynamic(() => import('./panes/UiwMdPane'),      { ssr: false, loading: () => <Loading name="@uiw/react-md-editor" /> });
const BlockNotePane  = dynamic(() => import('./panes/BlockNotePane'),  { ssr: false, loading: () => <Loading name="BlockNote" /> });
const PlatePane      = dynamic(() => import('./panes/PlatePane'),      { ssr: false, loading: () => <Loading name="Plate" /> });
const ToastUIPane    = dynamic(() => import('./panes/ToastUIPane'),    { ssr: false, loading: () => <Loading name="Toast UI" /> });
const VditorPane     = dynamic(() => import('./panes/VditorPane'),     { ssr: false, loading: () => <Loading name="Vditor" /> });
const LexicalPane    = dynamic(() => import('./panes/LexicalPane'),    { ssr: false, loading: () => <Loading name="Lexical" /> });

type EditorId = 'textarea' | 'monaco' | 'codemirror' | 'uiw' | 'toastui' | 'vditor' | 'milkdown' | 'tiptap' | 'blocknote' | 'plate' | 'lexical';

const EDITORS: Array<{ id: EditorId; label: string; tier: string; bundle: string; mdRoundTrip: string; }> = [
  { id: 'textarea',   label: 'Plain <textarea>',     tier: 'baseline',                 bundle: '0 KB',     mdRoundTrip: 'lossless' },
  { id: 'monaco',     label: 'Monaco',               tier: 'code editor',              bundle: '~900 KB',  mdRoundTrip: 'lossless' },
  { id: 'codemirror', label: 'CodeMirror 6',         tier: 'code editor',              bundle: '~150 KB',  mdRoundTrip: 'lossless' },
  { id: 'uiw',        label: '@uiw/react-md-editor', tier: 'split preview',            bundle: '~200 KB',  mdRoundTrip: 'lossless' },
  { id: 'toastui',    label: 'Toast UI',             tier: 'split + WYSIWYG modes',    bundle: '~400 KB',  mdRoundTrip: 'good' },
  { id: 'vditor',     label: 'Vditor',               tier: 'tri-mode (sv/ir/wysiwyg)', bundle: '~450 KB',  mdRoundTrip: 'good' },
  { id: 'milkdown',   label: 'Milkdown',             tier: 'WYSIWYG (md-native)',      bundle: '~180 KB',  mdRoundTrip: 'good (markdown core)' },
  { id: 'tiptap',     label: 'Tiptap',               tier: 'WYSIWYG (HTML core)',      bundle: '~150 KB',  mdRoundTrip: 'lossy (HTML→md)' },
  { id: 'blocknote',  label: 'BlockNote',            tier: 'WYSIWYG (Notion-style)',   bundle: '~250 KB',  mdRoundTrip: 'lossy' },
  { id: 'plate',      label: 'Plate',                tier: 'WYSIWYG (Slate)',          bundle: '~280 KB',  mdRoundTrip: 'good' },
  { id: 'lexical',    label: 'Lexical (raw)',        tier: 'WYSIWYG (Lexical, raw)',   bundle: '~50 KB core', mdRoundTrip: 'good (TRANSFORMERS)' },
];

export default function EditorDemoPage() {
  const [active, setActive] = useState<EditorId>('monaco');
  const [content, setContent] = useState(SPEC_CONTENT);
  const [perEditor, setPerEditor] = useState(false);
  const [perContent, setPerContent] = useState<Record<EditorId, string>>(() =>
    Object.fromEntries(EDITORS.map(e => [e.id, SPEC_CONTENT])) as Record<EditorId, string>
  );

  const value = perEditor ? perContent[active] : content;
  const setValue = (v: string) => {
    if (perEditor) setPerContent(prev => ({ ...prev, [active]: v }));
    else setContent(v);
  };

  const stats = useMemo(() => ({
    chars: value.length,
    lines: value.split('\n').length,
    words: value.trim().split(/\s+/).filter(Boolean).length,
  }), [value]);

  const meta = EDITORS.find(e => e.id === active)!;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0b0d10', color: '#e6e6e6', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #2a2a2a', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Markdown editor demo</h1>
        <span style={{ fontSize: 12, color: '#888' }}>
          {stats.lines} lines · {stats.words} words · {stats.chars.toLocaleString()} chars
        </span>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: '#aaa', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Checkbox checked={perEditor} onChange={setPerEditor} ariaLabel="Per-editor scratch buffers" />
          Per-editor scratch buffers
        </label>
        <button
          onClick={() => { perEditor ? setPerContent(prev => ({ ...prev, [active]: SPEC_CONTENT })) : setContent(SPEC_CONTENT); }}
          style={{ background: '#1a1d22', border: '1px solid #2a2a2a', color: '#ddd', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
        >
          Reset content
        </button>
      </header>

      <nav style={{ padding: '8px 20px', borderBottom: '1px solid #2a2a2a', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {EDITORS.map(e => (
          <button
            key={e.id}
            onClick={() => setActive(e.id)}
            style={{
              background: active === e.id ? '#2a3540' : '#15181c',
              border: '1px solid ' + (active === e.id ? '#4a90e2' : '#2a2a2a'),
              color: active === e.id ? '#fff' : '#bbb',
              padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >{e.label}</button>
        ))}
      </nav>

      <div style={{ padding: '8px 20px', borderBottom: '1px solid #2a2a2a', fontSize: 12, color: '#888', display: 'flex', gap: 24 }}>
        <span><strong style={{ color: '#bbb' }}>Tier:</strong> {meta.tier}</span>
        <span><strong style={{ color: '#bbb' }}>Bundle (gz approx):</strong> {meta.bundle}</span>
        <span><strong style={{ color: '#bbb' }}>Markdown round-trip:</strong> {meta.mdRoundTrip}</span>
      </div>

      <main style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex' }}>
        <div style={{ flex: 1, minHeight: 0, border: '1px solid #2a2a2a', borderRadius: 6, overflow: 'hidden', background: '#15181c' }}>
          {active === 'textarea' && (
            <textarea
              value={value}
              onChange={e => setValue(e.target.value)}
              spellCheck={false}
              style={{ width: '100%', height: '100%', background: '#15181c', color: '#e6e6e6', border: 0, padding: 16, fontFamily: 'ui-monospace, monospace', fontSize: 13, resize: 'none', outline: 'none' }}
            />
          )}
          {active === 'monaco'     && <MonacoPane     value={value} onChange={setValue} />}
          {active === 'codemirror' && <CodeMirrorPane value={value} onChange={setValue} />}
          {active === 'uiw'        && <UiwMdPane      value={value} onChange={setValue} />}
          {active === 'milkdown'   && <MilkdownPane   value={value} onChange={setValue} />}
          {active === 'tiptap'     && <TiptapPane     value={value} onChange={setValue} />}
          {active === 'blocknote'  && <BlockNotePane  value={value} onChange={setValue} />}
          {active === 'plate'      && <PlatePane      value={value} onChange={setValue} />}
          {active === 'toastui'    && <ToastUIPane    value={value} onChange={setValue} />}
          {active === 'vditor'     && <VditorPane     value={value} onChange={setValue} />}
          {active === 'lexical'    && <LexicalPane    value={value} onChange={setValue} />}
        </div>
      </main>
    </div>
  );
}

function Loading({ name }: { name: string }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 }}>
      Loading {name}…
    </div>
  );
}
