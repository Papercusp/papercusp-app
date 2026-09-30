/**
 * React + Tailwind code emitter.
 *
 * Walks an IR document and emits a single TSX surface file. v0.1
 * scope: cover the common kinds (stack/grid/header/list/card/text/
 * heading/button/icon/input/banner/empty-state/spinner/component
 * /chart/raw). Unknown kinds emit a TODO comment so missing coverage
 * surfaces clearly rather than silently dropping content.
 *
 * The emit is intentionally simple JSX-as-strings; no AST manipulation,
 * no formatter dependency. Output passes through prettier in a later
 * step if the consumer cares.
 */
import type { CodeEmitSurface, CodeEmitTarget, FileEmit } from '../design-adapter';
import type {
  ComponentBinding,
  Copy,
  UiIr,
  UiNode,
} from '../design-ir';

const ECOSYSTEM = 'react-tailwind';

interface EmitContext {
  /** componentBindings indexed by id */
  components: Map<string, ComponentBinding>;
  /** how much to indent each emitted JSX line */
  indent: number;
}

function ind(ctx: EmitContext): string {
  return '  '.repeat(ctx.indent);
}

function copyToString(c: Copy | undefined): string {
  if (!c) return '';
  // Simple inline; an i18n-aware adapter would emit `{t('key', 'default')}`.
  return c.default;
}

function tokenToTwClass(prefix: string, token: string | undefined): string {
  // gap.token "space.md" → "gap-[--space-md]"; placeholder mapping
  if (!token) return '';
  return `${prefix}-[var(--${token.replace(/\./g, '-')})]`;
}

function emitChildren(node: UiNode, ctx: EmitContext): string {
  const childCtx = { ...ctx, indent: ctx.indent + 1 };
  const parts: string[] = [];
  if (node.children) {
    for (const c of node.children) parts.push(emitNode(c, childCtx));
  }
  if (node.slots) {
    for (const v of Object.values(node.slots)) parts.push(emitNode(v, childCtx));
  }
  return parts.join('\n');
}

function emitNode(node: UiNode, ctx: EmitContext): string {
  const i = ind(ctx);
  switch (node.kind) {
    case 'stack': {
      const dir = node.direction === 'horizontal' ? 'flex-row' : 'flex-col';
      const gap = tokenToTwClass('gap', node.gap?.token);
      const pad = tokenToTwClass('p', node.padding?.token);
      const cls = ['flex', dir, gap, pad].filter(Boolean).join(' ');
      return `${i}<div className="${cls}">\n${emitChildren(node, ctx)}\n${i}</div>`;
    }
    case 'grid': {
      const gap = tokenToTwClass('gap', node.gap?.token);
      const pad = tokenToTwClass('p', node.padding?.token);
      const cls = ['grid', gap, pad].filter(Boolean).join(' ');
      return `${i}<div className="${cls}">\n${emitChildren(node, ctx)}\n${i}</div>`;
    }
    case 'header': {
      const title = copyToString(node.title);
      return `${i}<header className="flex items-center">\n${i}  <h2>${title}</h2>\n${i}</header>`;
    }
    case 'heading': {
      return `${i}<h2>${copyToString(node.copy ?? node.title ?? node.label)}</h2>`;
    }
    case 'text': {
      return `${i}<span>${copyToString(node.copy ?? node.label ?? node.title)}</span>`;
    }
    case 'list': {
      const empty = node.emptyState
        ? emitNode(node.emptyState, { ...ctx, indent: ctx.indent + 2 })
        : '';
      const item = node.item ? emitNode(node.item, { ...ctx, indent: ctx.indent + 2 }) : '';
      return [
        `${i}<ul className="flex flex-col">`,
        `${i}  {items.length === 0 ? (`,
        empty,
        `${i}  ) : (`,
        `${i}    items.map((item, idx) => (`,
        `${i}      <li key={idx}>`,
        item,
        `${i}      </li>`,
        `${i}    ))`,
        `${i}  )}`,
        `${i}</ul>`,
      ].join('\n');
    }
    case 'card': {
      const title = node.slots?.title;
      const body = node.slots?.body;
      const actions = node.slots?.actions;
      const slotIndent = { ...ctx, indent: ctx.indent + 2 };
      return [
        `${i}<article className="rounded border p-3 flex flex-col gap-2">`,
        title ? emitNode(title, slotIndent) : '',
        body ? emitNode(body, slotIndent) : '',
        actions ? emitNode(actions, slotIndent) : '',
        `${i}</article>`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'empty-state': {
      const copy = copyToString(node.copy);
      const icon = node.icon ? `${i}  <Icon name="${node.icon}" />` : '';
      return [
        `${i}<div className="flex flex-col items-center text-center py-8 gap-2">`,
        icon,
        `${i}  <p>${copy}</p>`,
        `${i}</div>`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'banner': {
      return `${i}<div role="status" className="rounded bg-amber-50 p-3">${copyToString(node.copy)}</div>`;
    }
    case 'spinner': {
      const live = node.a11y?.ariaLive ? ` aria-live="${node.a11y.ariaLive}"` : '';
      return `${i}<div${live} className="animate-spin">⏳</div>`;
    }
    case 'icon': {
      return `${i}<Icon name="${node.icon ?? ''}" />`;
    }
    case 'button': {
      const label = copyToString(node.a11y?.ariaLabel) || copyToString(node.label) || 'Action';
      const aria = node.a11y?.ariaLabel ? ` aria-label="${copyToString(node.a11y.ariaLabel)}"` : '';
      return `${i}<button${aria} className="px-3 py-1.5 rounded bg-blue-600 text-white">${label}</button>`;
    }
    case 'link': {
      return `${i}<a href="#">${copyToString(node.copy ?? node.label)}</a>`;
    }
    case 'input': {
      const ph = copyToString(node.placeholder);
      return `${i}<input type="text" placeholder="${ph}" className="border rounded px-2 py-1" />`;
    }
    case 'component': {
      const ref = node.ref;
      const binding = ref ? ctx.components.get(ref) : undefined;
      if (!binding) {
        return `${i}{/* TODO: missing component binding for ref="${ref ?? '?'}" */}`;
      }
      // Adapter doesn't know the registry's full importMap at this layer;
      // emit a placeholder import + use the registry id as the JSX name.
      const tag = registryIdToJsxTag(binding.registry);
      const propsStr = formatProps(binding.props);
      return `${i}<${tag}${propsStr} />`;
    }
    case 'chart': {
      // Defer to a Plotly host component the implementer wires up.
      return `${i}<PlotlyChart spec={${JSON.stringify(node.spec ?? {})}} />`;
    }
    case 'raw': {
      if (node.ecosystem === ECOSYSTEM && typeof node.payload === 'string') {
        return `${i}${node.payload}`;
      }
      return `${i}{/* raw payload from ecosystem="${node.ecosystem ?? '?'}" not supported */}`;
    }
    default:
      return `${i}{/* TODO emit kind="${node.kind}" */}`;
  }
}

function registryIdToJsxTag(registryId: string): string {
  // "action.primary" → "ActionPrimary"
  return registryId
    .split('.')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function formatProps(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string') parts.push(`${k}="${v}"`);
    else parts.push(`${k}={${JSON.stringify(v)}}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function usageFor(ir: UiIr): { hasIcon: boolean; hasChart: boolean } {
  let hasIcon = false;
  let hasChart = false;
  const walk = (n: UiNode | undefined) => {
    if (!n) return;
    if (n.kind === 'icon' || n.icon) hasIcon = true;
    if (n.kind === 'chart') hasChart = true;
    if (n.children) n.children.forEach(walk);
    if (n.slots) Object.values(n.slots).forEach(walk);
    if (n.item) walk(n.item);
    if (n.emptyState) walk(n.emptyState);
  };
  walk(ir.layout);
  return { hasIcon, hasChart };
}

function emitImports(ir: UiIr): string {
  const tags = new Set<string>();
  for (const c of ir.components ?? []) tags.add(registryIdToJsxTag(c.registry));
  const { hasIcon, hasChart } = usageFor(ir);
  const lines = ["import * as React from 'react';"];
  if (tags.size > 0) {
    lines.push(
      `// TODO: import ${[...tags].join(', ')} via the react-tailwind registry importHints before using this preview.`,
    );
  }
  if (hasIcon) lines.push("import * as LucideIcons from 'lucide-react';");
  if (hasChart) lines.push("import { PlotlyChart } from '@papercusp/charts';");
  return lines.join('\n');
}

function emitHelpers(ir: UiIr): string {
  const { hasIcon } = usageFor(ir);
  if (!hasIcon) return '';
  return [
    'function Icon({ name }: { name: string }) {',
    "  const key = name.replace(/(^|[-_\\s]+)([a-z])/g, (_match, _sep, char) => char.toUpperCase());",
    "  const icons = LucideIcons as unknown as Record<string, React.ComponentType<{ 'aria-hidden'?: boolean }>>;",
    '  const Component = icons[key] ?? icons.Circle;',
    '  return <Component aria-hidden />;',
    '}',
  ].join('\n');
}

function deriveComponentName(surface: string): string {
  // "operator-panel" → "OperatorPanelSurface"
  return (
    surface
      .split(/[-_/]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('') + 'Surface'
  );
}

function emitSurface(ir: UiIr): string {
  const ctx: EmitContext = {
    components: new Map((ir.components ?? []).map((c) => [c.id, c])),
    indent: 2,
  };
  const compName = deriveComponentName(ir.surface);
  const body = emitNode(ir.layout, ctx);
  const lines = [
    '// Generated by papercusp-design-react-tailwind from UI IR.',
    `// surface=${ir.surface}  irVersion=${ir.irVersion}`,
    '// Do not edit; regenerate from the design spec.',
    emitImports(ir),
    emitHelpers(ir),
    '',
    `export interface ${compName}Props {`,
    '  items?: unknown[];',
    '}',
    '',
    `export function ${compName}({ items = [] }: ${compName}Props) {`,
    '  return (',
    body,
    '  );',
    '}',
    '',
  ];
  return lines.join('\n');
}

export function makeReactTailwindCodeEmit(): CodeEmitSurface {
  return {
    async fromIR(ir: UiIr, target: CodeEmitTarget): Promise<FileEmit[]> {
      const filename = `${ir.surface}.generated.tsx`;
      return [
        {
          path: target.outDir.replace(/\/$/, '') + '/' + filename,
          contents: emitSurface(ir),
          overwrite: true,
        },
      ];
    },
  };
}

export const _internal = { emitNode, emitSurface, registryIdToJsxTag, deriveComponentName, usageFor };
