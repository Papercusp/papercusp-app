/**
 * remark-work-refs.ts — remark plugin that splices a custom `workRefPill`
 * mdast node in place of every WI-/EI-/F-/P- ref found in chat message prose
 * (chat-ref-pills-2026-07-26 P-004). Reuses parseWorkRefs (P-001) for the
 * actual extraction rather than re-deriving ref matching here.
 *
 * Why a tree transform instead of visiting raw text with unist-util-visit:
 * mdast already segregates fenced code blocks / inline code spans into their
 * own `code`/`inlineCode` node types (string `value`, no phrasing `children`
 * to descend into) — so simply never recursing into a childless node is
 * "must NOT linkify inside code spans or fenced blocks" for free, with no
 * extra masking logic needed at this layer (parseWorkRefs's own raw-text
 * masking already covers non-mdast callers). The one thing mdast does NOT
 * separate out for us is an existing markdown link's label — `[WI-123](url)`
 * still has a `text` child node whose value is the bare ref — so a plain
 * per-node visit would double-linkify it into a nested, invalid `<a>` inside
 * `<a>`. `transformChildren` tracks whether it is currently inside a
 * `link`/`linkReference` subtree and skips ref-splitting there.
 */
import type { Root, RootContent, Text } from 'mdast';
import { parseWorkRefs, type WorkRefMatch } from './parse-work-refs';

/** The custom mdast node type spliced in for one matched ref. `data.hName` +
 *  `data.hProperties` are the mdast-to-hast contract (react-markdown's
 *  internal remark-rehype step reads these) that turns this node into a
 *  `workrefpill` hast element carrying `refId`/`refKind` — which
 *  markdown component map in PapercupChat.tsx intercepts via its own
 *  `workrefpill` component override and renders as a real
 *  HydratedWorkRefPill/WorkRefPill. Deliberately plain camelCase keys (not
 *  `data-ref-id`-style attribute names): this node is NEVER rendered as a
 *  literal DOM element — the override always wins — so there's no need to
 *  round-trip through hast's HTML-attribute-name normalization, and reading
 *  `node.properties.refId` on the other end stays unambiguous. */
export interface WorkRefPillNode {
  type: 'workRefPill';
  data: {
    hName: 'workrefpill';
    hProperties: { refId: string; refKind: WorkRefMatch['kind'] };
  };
  children: [];
}

function splitTextNode(node: Text): Array<Text | WorkRefPillNode> {
  const matches = parseWorkRefs(node.value);
  if (matches.length === 0) return [node];

  const out: Array<Text | WorkRefPillNode> = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) out.push({ type: 'text', value: node.value.slice(cursor, m.start) });
    out.push({
      type: 'workRefPill',
      data: { hName: 'workrefpill', hProperties: { refId: m.id, refKind: m.kind } },
      children: [],
    });
    cursor = m.end;
  }
  if (cursor < node.value.length) out.push({ type: 'text', value: node.value.slice(cursor) });
  return out;
}

/**
 * Recursively rebuild a phrasing-content children array: split every `text`
 * node into text + workRefPill segments, except while `insideLink` (a ref
 * that IS (or is nested inside, e.g. bold text inside) an existing link's
 * label is left as plain text — it's already linked, and a nested pill-link
 * would be an invalid nested `<a>`). A node with no `children` array
 * (`inlineCode`, `code`, `image`, …) is returned as-is and never descended
 * into, which is what keeps refs inside code spans/fences un-linkified.
 */
function transformChildren(nodes: RootContent[], insideLink: boolean): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    if (node.type === 'text' && !insideLink) {
      out.push(...(splitTextNode(node as Text) as unknown as RootContent[]));
      continue;
    }
    const children = (node as { children?: RootContent[] }).children;
    if (Array.isArray(children)) {
      const nextInsideLink = insideLink || node.type === 'link' || node.type === 'linkReference';
      out.push({ ...node, children: transformChildren(children, nextInsideLink) } as RootContent);
      continue;
    }
    out.push(node);
  }
  return out;
}

/** remark plugin factory — pass to `ReactMarkdown`'s `remarkPlugins` array
 *  (after remark-gfm, so GFM's own syntax expansions like autolinks have
 *  already run before we scan the resulting text nodes). */
export function remarkWorkRefs() {
  return (tree: Root) => {
    tree.children = transformChildren(tree.children as RootContent[], false) as Root['children'];
  };
}
