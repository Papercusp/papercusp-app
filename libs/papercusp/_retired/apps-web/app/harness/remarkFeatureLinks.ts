import { visit, SKIP } from 'unist-util-visit';
import type { Root, Text } from 'mdast';

// Matches F-001, F-FIX-001, F-IDEA-001, F-BUGS-12, etc.
// Requires word boundaries so we don't match substrings like "XFY-001".
const FEATURE_ID_RE = /\bF-(?:[A-Z]+-)?\d+\b/g;

/**
 * Remark plugin: turns feature-id mentions (F-001, F-FIX-001, etc.) in text
 * nodes into link nodes with a `data-fid` property. The `a` renderer on the
 * React side can then render these as chips/hovercards.
 */
export function remarkFeatureLinks() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      // Don't re-link inside links or code
      if (parent.type === 'link' || parent.type === 'inlineCode' || parent.type === 'code') return;

      const matches = [...node.value.matchAll(FEATURE_ID_RE)];
      if (matches.length === 0) return;

      const newNodes: Array<Text | { type: 'link'; url: string; data?: any; children: Text[] }> = [];
      let last = 0;
      for (const m of matches) {
        const start = m.index ?? 0;
        if (start > last) {
          newNodes.push({ type: 'text', value: node.value.slice(last, start) });
        }
        const fid = m[0];
        newNodes.push({
          type: 'link',
          url: `#feature-${fid}`,
          data: {
            hName: 'a',
            hProperties: {
              'data-fid': fid,
              className: 'h-fid-link',
            },
          },
          children: [{ type: 'text', value: fid }],
        });
        last = start + m[0].length;
      }
      if (last < node.value.length) {
        newNodes.push({ type: 'text', value: node.value.slice(last) });
      }

      parent.children.splice(index, 1, ...(newNodes as any));
      return [SKIP, index + newNodes.length];
    });
  };
}
