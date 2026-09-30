import type { DependencyBottleneckGraph, DependencyTraversalRelation } from './dependency-traversal';

const MAX_NODE_TITLE_CHARS = 96;

function clipLabel(value: string, max = MAX_NODE_TITLE_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'");
}

function relationSyntax(relation: DependencyTraversalRelation): string {
  if (relation === 'coverage') return '-.->|coverage|';
  if (relation === 'external-blocker') return '-->|blocked by external|';
  return '-->|blocked by|';
}

/**
 * Render the optional human view from the graph rows returned alongside the
 * ranked bottlenecks. This function is deliberately pure: SQL owns graph truth;
 * the renderer only assigns stable Mermaid ids and presentation labels.
 */
export function renderDependencyBottleneckMermaid(graph: DependencyBottleneckGraph): string {
  const nodes = [...graph.nodes].sort((a, b) => a.key.localeCompare(b.key));
  const nodeIds = new Map(nodes.map((node, index) => [node.key, `n${index}`]));
  const lines = ['```mermaid', 'flowchart LR'];

  if (nodes.length === 0) {
    lines.push('  empty["No open dependency paths"]');
  } else {
    for (const node of nodes) {
      const parts = [node.ref, node.status, node.title && node.title !== node.ref ? clipLabel(node.title) : null]
        .filter((part): part is string => Boolean(part));
      lines.push(`  ${nodeIds.get(node.key)}["${escapeMermaidLabel(parts.join(' · '))}"]`);
    }
  }

  let danglingEdges = 0;
  for (const edge of [...graph.edges].sort((a, b) => a.key.localeCompare(b.key))) {
    const subject = nodeIds.get(edge.subjectKey);
    const dependency = nodeIds.get(edge.dependencyKey);
    if (!subject || !dependency) {
      danglingEdges += 1;
      continue;
    }
    lines.push(`  ${subject} ${relationSyntax(edge.relation)} ${dependency}`);
  }
  if (danglingEdges > 0) lines.push(`  %% omitted ${danglingEdges} dangling edge(s)`);
  lines.push('```');
  return lines.join('\n');
}
