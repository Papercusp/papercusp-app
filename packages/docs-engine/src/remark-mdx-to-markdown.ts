/**
 * remark-mdx-to-markdown — convert MDX JSX nodes to plain markdown.
 *
 * Without this, our llms.mdx routes and docs:get output emit literal
 * JSX tags (`<Callout type="warning">…</Callout>`) into the markdown
 * stream — agents can read them, but the rendering is noisier than it
 * needs to be. This plugin walks the AST and replaces MDX JSX nodes
 * with a markdown-friendly equivalent:
 *
 *   <Callout type="warning"> body </Callout>
 *     → > **Warning:** body
 *
 *   <Callout title="Heads up"> body </Callout>
 *     → > **Heads up:** body
 *
 *   <Tabs|TabsList|TabsTrigger|TabsContent|Tab>
 *   <Steps|Step>
 *   <Card|Cards>
 *     → unwrap (drop tag, keep children inline)
 *
 *   Anything else MDX-JSX with children:
 *     → unwrap (defensive — better than a literal tag)
 *
 *   Self-closing unknown JSX with no children:
 *     → drop entirely
 *
 * Code-fence JSX is untouched because the MDX parser doesn't lift it
 * into mdxJsx* nodes — it stays as raw text inside `code` nodes.
 *
 * Scope: read-only doc rendering for agents. Not for production HTML.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, RootContent, Blockquote, Text } from 'mdast';

const UNWRAP_NAMES = new Set([
  'Tabs',
  'TabsList',
  'TabsTrigger',
  'TabsContent',
  'Tab',
  'Steps',
  'Step',
  'Card',
  'Cards',
  'Accordion',
  'Accordions',
  'CardGrid',
]);

const CALLOUT_TITLES: Record<string, string> = {
  warn: 'Warning',
  warning: 'Warning',
  error: 'Error',
  danger: 'Error',
  info: 'Note',
  note: 'Note',
  success: 'Tip',
  tip: 'Tip',
};

interface MdxJsxAttribute {
  type: 'mdxJsxAttribute';
  name: string;
  value?: string | { type: 'mdxJsxAttributeValueExpression'; value: string } | null;
}

interface MdxJsxFlowElement {
  type: 'mdxJsxFlowElement';
  name?: string | null;
  attributes?: MdxJsxAttribute[];
  children?: RootContent[];
}

interface MdxJsxTextElement {
  type: 'mdxJsxTextElement';
  name?: string | null;
  attributes?: MdxJsxAttribute[];
  children?: RootContent[];
}

function getAttr(
  attrs: MdxJsxAttribute[] | undefined,
  name: string,
): string | undefined {
  if (!attrs) return undefined;
  for (const a of attrs) {
    if (a.type !== 'mdxJsxAttribute' || a.name !== name) continue;
    if (typeof a.value === 'string') return a.value;
    if (a.value && typeof a.value === 'object' && 'value' in a.value) {
      // JSX expression — strip surrounding quotes if present
      return a.value.value.replace(/^['"`]|['"`]$/g, '');
    }
  }
  return undefined;
}

function calloutToBlockquote(node: MdxJsxFlowElement | MdxJsxTextElement): Blockquote {
  const type = (getAttr(node.attributes, 'type') ?? 'note').toLowerCase();
  const title = getAttr(node.attributes, 'title') ?? CALLOUT_TITLES[type] ?? 'Note';
  const prefix: Text = { type: 'text', value: `${title}: ` };

  // Wrap children so the blockquote contains a paragraph with [strong prefix] + originals.
  const childrenSafe: RootContent[] = (node.children ?? []) as RootContent[];

  return {
    type: 'blockquote',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'strong', children: [prefix] },
        ],
      },
      ...(childrenSafe as Blockquote['children']),
    ],
  };
}

const remarkMdxToMarkdown: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') {
        return;
      }
      const jsx = node as unknown as MdxJsxFlowElement | MdxJsxTextElement;
      const name = jsx.name ?? '';

      if (name === 'Callout') {
        const replacement = calloutToBlockquote(jsx);
        // SAFETY: blockquote is a valid block where the JSX was; if the
        // JSX was inline (mdxJsxTextElement) we still emit blockquote
        // which the markdown stringifier handles. Inline callouts are
        // rare; the trade-off is worth it for the simpler plugin.
        (parent.children as RootContent[]).splice(index, 1, replacement as unknown as RootContent);
        return [SKIP, index];
      }

      if (UNWRAP_NAMES.has(name)) {
        const children = (jsx.children ?? []) as RootContent[];
        (parent.children as RootContent[]).splice(index, 1, ...children);
        return [SKIP, index];
      }

      // Default unknown JSX: unwrap children (or drop self-closing tags).
      const children = (jsx.children ?? []) as RootContent[];
      (parent.children as RootContent[]).splice(index, 1, ...children);
      return [SKIP, index];
    });
  };
};

export default remarkMdxToMarkdown;
