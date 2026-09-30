'use strict';
/**
 * example-tool-pack — reference code-tool pack
 * (tool-distribution-granularity-2026-06-05 D-001/D-004).
 *
 * A pack is the degenerate runtime-less distribution unit: statically-declared
 * in-process tools and NOTHING else (no ui/roles/routines/actions/hooks, js
 * runtime only — the loader enforces this for kind: 'pack'). The host projects
 * the tools onto both transports exactly like plugin tools:
 *   MCP  example-tool-pack.word_count / example-tool-pack.slugify
 *   HTTP /api/plugins/example-tool-pack/{word_count,slugify}
 *
 * Shipped as CommonJS (.cjs) so the loader's createRequire path can import it
 * without a TS toolchain.
 */

function wordCount(input) {
  const text = typeof input?.text === 'string' ? input.text : null;
  if (text == null) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'text (string) required' }) }], isError: true };
  }
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  const lines = text === '' ? 0 : text.split(/\r\n|\r|\n/).length;
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, words, lines, chars: text.length }) }],
  };
}

function slugify(input) {
  const text = typeof input?.text === 'string' ? input.text : null;
  if (text == null) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'text (string) required' }) }], isError: true };
  }
  const max = Number.isInteger(input?.maxLength) && input.maxLength > 0 ? input.maxLength : 80;
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, slug }) }] };
}

module.exports = {
  kind: 'pack',
  name: 'example-tool-pack',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Reference code-tool pack (D-001/D-004).',
  capabilities: ['tools:text:word_count', 'tools:text:slugify'],
  tools: {
    word_count: wordCount,
    slugify,
  },
};
