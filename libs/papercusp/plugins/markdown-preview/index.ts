/**
 * Plugin core for markdown-preview (Batch H7 smoke plugin).
 *
 * Single action `render`: takes `{markdown: string}` and returns
 * `{html: string}`. The actual rendering is intentionally trivial
 * (no external dep): a few line-level regexes covering headings,
 * inline emphasis, code spans, and paragraph breaks. The point of
 * this plugin is exercising the iframe → core RPC path, not building
 * a Markdown engine.
 */
import type { Plugin } from '@papercusp/plugin-sdk';

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tinyMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) { out.push(''); continue; }
    let l = escape(raw);
    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) { out.push(`<h${h[1]!.length}>${escape(h[2]!)}</h${h[1]!.length}>`); continue; }
    // inline code
    l = l.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bold + italic
    l = l.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    l = l.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out.push(`<p>${l}</p>`);
  }
  return out.filter((x) => x !== '').join('\n');
}

const plugin: Plugin = {
  name: 'markdown-preview',
  version: '0.1.0',
  description: 'Markdown preview iframe smoke',
  capabilities: [],
  actions: [
    {
      name: 'render',
      capabilities: [],
      handler: async (params: unknown) => {
        const p = params as { markdown?: string } | null;
        const md = typeof p?.markdown === 'string' ? p.markdown : '';
        return { html: tinyMarkdown(md) };
      },
    },
  ],
} as unknown as Plugin;

export default plugin;
