'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HeadingNode, QuoteNode, $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode, INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND } from '@lexical/list';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $setBlocksType } from '@lexical/selection';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import {
  $getSelection, $isRangeSelection, $createParagraphNode,
  FORMAT_TEXT_COMMAND, UNDO_COMMAND, REDO_COMMAND,
} from 'lexical';
import { useRef, useEffect, useState } from 'react';

const theme = {
  paragraph: 'lex-p',
  heading: { h1: 'lex-h1', h2: 'lex-h2', h3: 'lex-h3', h4: 'lex-h4' },
  list: { ul: 'lex-ul', ol: 'lex-ol', listitem: 'lex-li' },
  quote: 'lex-quote',
  code: 'lex-code',
  link: 'lex-a',
  text: { bold: 'lex-bold', italic: 'lex-italic', code: 'lex-inline-code', strikethrough: 'lex-strike', underline: 'lex-u' },
};

function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [active, setActive] = useState({ bold: false, italic: false, code: false });

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          setActive({
            bold: sel.hasFormat('bold'),
            italic: sel.hasFormat('italic'),
            code: sel.hasFormat('code'),
          });
        }
      });
    });
  }, [editor]);

  const setBlock = (creator: () => any) => () => {
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) $setBlocksType(sel, creator);
    });
  };

  const btn = (label: string, onClick: () => void, isActive = false, title?: string) => (
    <Tooltip label={title ?? label}><button
      type="button"

      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        background: isActive ? '#2a3540' : 'transparent',
        border: '1px solid ' + (isActive ? '#4a90e2' : '#2a2a2a'),
        color: '#ddd', padding: '4px 8px', borderRadius: 3, cursor: 'pointer',
        fontSize: 12, fontFamily: 'inherit', minWidth: 28,
      }}
    >{label}</button></Tooltip>
  );

  return (
    <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #2a2a2a', background: '#1a1d22', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 1 }}>
      {btn('↶', () => editor.dispatchCommand(UNDO_COMMAND, undefined), false, 'Undo')}
      {btn('↷', () => editor.dispatchCommand(REDO_COMMAND, undefined), false, 'Redo')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('B', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'), active.bold, 'Bold')}
      {btn('I', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'), active.italic, 'Italic')}
      {btn('</>', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code'), active.code, 'Inline code')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('P',  setBlock(() => $createParagraphNode()), false, 'Paragraph')}
      {btn('H1', setBlock(() => $createHeadingNode('h1')), false, 'Heading 1')}
      {btn('H2', setBlock(() => $createHeadingNode('h2')), false, 'Heading 2')}
      {btn('H3', setBlock(() => $createHeadingNode('h3')), false, 'Heading 3')}
      {btn('"', setBlock(() => $createQuoteNode()), false, 'Quote')}
      <span style={{ width: 1, background: '#2a2a2a', margin: '0 4px' }} />
      {btn('• List', () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined), false, 'Bulleted list')}
      {btn('1. List', () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined), false, 'Numbered list')}
    </div>
  );
}

export default function LexicalPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const initial = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const initialConfig = {
    namespace: 'editor-demo',
    theme,
    onError: (e: Error) => { console.error('Lexical error:', e); },
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode, LinkNode],
    editorState: () => $convertFromMarkdownString(initial.current, TRANSFORMERS),
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#15181c', color: '#e6e6e6' }}>
      <style>{`
        .lex-h1 { font-size: 1.8em; margin: 0.6em 0 0.3em; color: #fff; font-weight: 700; }
        .lex-h2 { font-size: 1.4em; margin: 0.6em 0 0.3em; color: #fff; font-weight: 700; }
        .lex-h3 { font-size: 1.15em; margin: 0.5em 0 0.3em; color: #fff; font-weight: 600; }
        .lex-h4 { font-size: 1em; margin: 0.5em 0 0.3em; color: #fff; font-weight: 600; }
        .lex-p { margin: 0.5em 0; }
        .lex-ul, .lex-ol { margin: 0.5em 0; padding-left: 24px; }
        .lex-ul { list-style: disc; }
        .lex-ol { list-style: decimal; }
        .lex-li { margin: 0.2em 0; }
        .lex-quote { border-left: 3px solid #4a90e2; padding-left: 12px; color: #aaa; margin: 0.5em 0; font-style: italic; }
        .lex-code { background: #1a1d22; padding: 8px; border-radius: 4px; border: 1px solid #2a2a2a; font-family: ui-monospace, monospace; display: block; white-space: pre-wrap; }
        .lex-inline-code { background: #2a2a2a; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, monospace; }
        .lex-a { color: #6ab0ff; }
        .lex-bold { font-weight: 700; color: #fff; }
        .lex-italic { font-style: italic; }
        .lex-strike { text-decoration: line-through; }
        .lex-u { text-decoration: underline; }
        .lex-content { outline: none; min-height: 100%; padding: 20px; }
      `}</style>
      <LexicalComposer initialConfig={initialConfig}>
        <ToolbarPlugin />
        <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <RichTextPlugin
            contentEditable={<ContentEditable className="lex-content" />}
            placeholder={<div style={{ position: 'absolute', top: 20, left: 20, color: '#555', pointerEvents: 'none' }}>Start typing…</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <OnChangePlugin
          onChange={(state) => {
            state.read(() => {
              try {
                const md = $convertToMarkdownString(TRANSFORMERS);
                onChangeRef.current(md);
              } catch { /* mid-edit invalid state */ }
            });
          }}
        />
      </LexicalComposer>
    </div>
  );
}
