'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { Plate, PlateContent, PlateElement, PlateLeaf, useEditorRef, usePlateEditor } from '@udecode/plate/react';
import { BasicElementsPlugin } from '@udecode/plate-basic-elements/react';
import { BasicMarksPlugin } from '@udecode/plate-basic-marks/react';
import { ListPlugin, BulletedListPlugin, NumberedListPlugin } from '@udecode/plate-list/react';
import { MarkdownPlugin } from '@udecode/plate-markdown';
import { useRef } from 'react';

const components = {
  h1: (props: any) => <PlateElement as="h1" className="plate-h1" {...props} />,
  h2: (props: any) => <PlateElement as="h2" className="plate-h2" {...props} />,
  h3: (props: any) => <PlateElement as="h3" className="plate-h3" {...props} />,
  h4: (props: any) => <PlateElement as="h4" className="plate-h4" {...props} />,
  h5: (props: any) => <PlateElement as="h5" className="plate-h5" {...props} />,
  h6: (props: any) => <PlateElement as="h6" className="plate-h6" {...props} />,
  p:  (props: any) => <PlateElement as="p"  className="plate-p"  {...props} />,
  blockquote: (props: any) => <PlateElement as="blockquote" className="plate-quote" {...props} />,
  code_block: (props: any) => <PlateElement as="pre" className="plate-pre" {...props} />,
  code_line: (props: any) => <PlateElement as="div" {...props} />,
  ul: (props: any) => <PlateElement as="ul" className="plate-ul" {...props} />,
  ol: (props: any) => <PlateElement as="ol" className="plate-ol" {...props} />,
  li: (props: any) => <PlateElement as="li" className="plate-li" {...props} />,
  lic: (props: any) => <PlateElement as="div" className="plate-lic" {...props} />,
  bold:          (props: any) => <PlateLeaf as="strong" className="plate-bold" {...props} />,
  italic:        (props: any) => <PlateLeaf as="em" className="plate-italic" {...props} />,
  code:          (props: any) => <PlateLeaf as="code" className="plate-inline-code" {...props} />,
  underline:     (props: any) => <PlateLeaf as="u" {...props} />,
  strikethrough: (props: any) => <PlateLeaf as="s" {...props} />,
};

function PlateToolbar() {
  const editor = useEditorRef();

  const btn = (label: string, onClick: () => void, title?: string) => (
    <Tooltip label={title ?? label}><button
      type="button"

      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { editor.tf.focus(); onClick(); }}
      style={{
        background: 'transparent',
        border: '1px solid #2a2a2a',
        color: '#ddd', padding: '4px 8px', borderRadius: 3, cursor: 'pointer',
        fontSize: 12, fontFamily: 'inherit', minWidth: 28,
      }}
    >{label}</button></Tooltip>
  );

  return (
    <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #2a2a2a', background: '#1a1d22', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 1 }}>
      {btn('↶', () => editor.undo(), 'Undo')}
      {btn('↷', () => editor.redo(), 'Redo')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('B', () => editor.tf.toggleMark('bold'), 'Bold')}
      {btn('I', () => editor.tf.toggleMark('italic'), 'Italic')}
      {btn('</>', () => editor.tf.toggleMark('code'), 'Inline code')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('P',  () => editor.tf.toggleBlock('p'), 'Paragraph')}
      {btn('H1', () => editor.tf.toggleBlock('h1'), 'Heading 1')}
      {btn('H2', () => editor.tf.toggleBlock('h2'), 'Heading 2')}
      {btn('H3', () => editor.tf.toggleBlock('h3'), 'Heading 3')}
      {btn('"', () => editor.tf.toggleBlock('blockquote'), 'Quote')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('• List', () => editor.getTransforms(BulletedListPlugin).toggle.list(), 'Bulleted list')}
      {btn('1. List', () => editor.getTransforms(NumberedListPlugin).toggle.list(), 'Numbered list')}
    </div>
  );
}

export default function PlatePane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const initial = useRef(value);

  const editor = usePlateEditor({
    plugins: [BasicElementsPlugin, BasicMarksPlugin, ListPlugin, MarkdownPlugin],
    components,
    value: (e) => e.getApi(MarkdownPlugin).markdown.deserialize(initial.current),
  });

  const handleChange = () => {
    try {
      const md = editor.getApi(MarkdownPlugin).markdown.serialize();
      onChange(md);
    } catch { /* serialize may throw mid-edit on incomplete trees */ }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#15181c', color: '#e6e6e6' }}>
      <style>{`
        .plate-h1 { font-size: 1.8em; margin: 0.6em 0 0.3em; color: #fff; font-weight: 700; }
        .plate-h2 { font-size: 1.4em; margin: 0.6em 0 0.3em; color: #fff; font-weight: 700; }
        .plate-h3 { font-size: 1.15em; margin: 0.5em 0 0.3em; color: #fff; font-weight: 600; }
        .plate-h4, .plate-h5, .plate-h6 { font-size: 1em; margin: 0.5em 0 0.3em; color: #fff; font-weight: 600; }
        .plate-p { margin: 0.5em 0; }
        .plate-quote { border-left: 3px solid #4a90e2; padding: 0 0 0 12px; margin: 0.5em 0; color: #aaa; font-style: italic; }
        .plate-pre { background: #1a1d22; padding: 12px; border-radius: 4px; border: 1px solid #2a2a2a; overflow-x: auto; font-family: ui-monospace, monospace; font-size: 0.9em; }
        .plate-inline-code { background: #2a2a2a; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 0.92em; }
        .plate-bold { color: #fff; font-weight: 700; }
        .plate-italic { font-style: italic; }
        .plate-ul { list-style: disc; padding-left: 24px; margin: 0.5em 0; }
        .plate-ol { list-style: decimal; padding-left: 24px; margin: 0.5em 0; }
        .plate-li { margin: 0.2em 0; }
        .plate-lic { display: inline; }
        [data-slate-editor] { outline: none; min-height: 100%; padding: 20px; }
        [data-slate-editor] a { color: #6ab0ff; }
      `}</style>
      <Plate editor={editor} onChange={handleChange}>
        <PlateToolbar />
        <div style={{ flex: 1, overflow: 'auto' }}>
          <PlateContent placeholder="Start typing…" />
        </div>
      </Plate>
    </div>
  );
}
