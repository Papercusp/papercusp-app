'use client';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MantineProvider, createTheme } from '@mantine/core';
import { RichTextEditor } from '@mantine/tiptap';
import { useRef } from 'react';

import '@mantine/core/styles.css';
import '@mantine/tiptap/styles.css';

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'sm',
});

export default function TiptapPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const initial = useRef(value);
  const editor = useEditor({
    extensions: [StarterKit],
    content: mdToHtml(initial.current),
    immediatelyRender: false,
    onUpdate: ({ editor }) => onChange(htmlToMd(editor.getHTML())),
  });

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#15181c', color: '#e6e6e6' }}>
        <RichTextEditor editor={editor} variant="subtle" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, border: 0 }}>
          <RichTextEditor.Toolbar sticky stickyOffset={0}>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.Undo />
              <RichTextEditor.Redo />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.Bold />
              <RichTextEditor.Italic />
              <RichTextEditor.Strikethrough />
              <RichTextEditor.Code />
              <RichTextEditor.ClearFormatting />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.H1 />
              <RichTextEditor.H2 />
              <RichTextEditor.H3 />
              <RichTextEditor.H4 />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.Blockquote />
              <RichTextEditor.Hr />
              <RichTextEditor.BulletList />
              <RichTextEditor.OrderedList />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.Link />
              <RichTextEditor.Unlink />
            </RichTextEditor.ControlsGroup>
            <RichTextEditor.ControlsGroup>
              <RichTextEditor.CodeBlock />
            </RichTextEditor.ControlsGroup>
          </RichTextEditor.Toolbar>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <RichTextEditor.Content />
          </div>
        </RichTextEditor>
      </div>
    </MantineProvider>
  );
}

function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flushPara();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^---+$/.test(line)) { flushPara(); out.push('<hr/>'); continue; }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { flushPara(); out.push('<ul><li>' + inline(li[1]) + '</li></ul>'); continue; }
    const oli = line.match(/^\d+\.\s+(.*)$/);
    if (oli) { flushPara(); out.push('<ol><li>' + inline(oli[1]) + '</li></ol>'); continue; }
    if (line.startsWith('> ')) { flushPara(); out.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>'); continue; }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return out.join('\n');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlToMd(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/g, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/g, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/g, '### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/g, '#### $1\n')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<code>(.*?)<\/code>/g, '`$1`')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)')
    .replace(/<li>(.*?)<\/li>/g, '- $1')
    .replace(/<\/?ul>|<\/?ol>/g, '')
    .replace(/<blockquote>(.*?)<\/blockquote>/g, '> $1\n')
    .replace(/<hr ?\/?>/g, '\n---\n')
    .replace(/<p>(.*?)<\/p>/g, '$1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}
